import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { AutoSplitter } from '#modules/board/auto.splitter.js';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { withAttempt, withoutAttempts, type Attempt } from '#modules/board/append.attempts.js';
import { withFindings } from '#modules/board/append.findings.js';
import { filesInScope, type Card } from '#modules/board/card.js';
import { unsatisfiedDependencies } from '#modules/board/next.card.js';
import { StageHeldError, StageInterruptedError, type InterruptedAttempt } from '#modules/agent/stage.interrupt.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { ScopeKickbackError } from '#modules/agent/tools/index.js';
import { StageAgentMap } from '#modules/agent/stage.agent.js';
import { EventLog } from '#modules/events/event.log.js';
import { HostPlacer, NoHostAvailable } from '#modules/host/host.placer.js';
import { HostLostError, type RemotePlacement } from '#modules/host/placement.js';
import { LearningsStore } from '#modules/learnings/learnings.store.js';
import { DevServerPortAllocator } from '#modules/lease/dev.server.port.allocator.js';
import { Notifier } from '#modules/notify/notifier.js';
import type { CardNotification } from '#modules/notify/notification.js';
import { DEV_SERVER_PORT_RANGE } from '#modules/settings/dev.server.port.range.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { snapshotDrift, WorktreeManager, type Worktree } from '#modules/worktree/worktree.manager.js';
import { cardOverBudget } from './card.budget.js';
import { kickback, shouldAdvance, type KickbackDecision } from './kickback.js';
import { findStage, isPlanCheck, type ProjectStages, type StageConfig } from './stage.config.js';
import { StageConfigStore } from './stage.config.store.js';
import { StageResultSchemaMap, type ReviewCriterion, type ReviewFinding, type StageOutcome } from './stage.result.js';
import { executeStage, type StageExecutionInput } from './stage.execution.js';
import { prepareStage } from './stage.preparation.js';
import { StageVerifierMap } from './stage.verifier.js';
import { endingOf } from './terminal.js';

/**
 * Which of `assertDispatchable`'s conditions fired, carried on the error it throws.
 *
 * All of them are deterministic against a fixed card — retrying changes nothing — but they are not
 * all the same kind of "never". Empty scope requires a human to change the card before any attempt
 * can succeed. `needs-human` is the same shape: the flag has to be acknowledged
 * before the card moves. An unsatisfied dependency is "not now", not "never": the dependency landing
 * makes the card dispatchable again with no change to the card itself. `CardStageJob` branches on
 * this discriminant, not the message text, to route each case correctly — and a variant added here
 * without a branch there falls to its default, which is `poison()`. That is how card 0109's own
 * first pass turned a flagged card into a terminal one; add the route with the variant.
 *
 * `wrong-stage` carries `actualStage` so the `stage.stale` event a stale job leaves can say where
 * the card went (card 0084).
 *
 * `needs-human` exists for the same reason `wrong-stage` does: a card can be flagged between the
 * moment a job is enqueued and the moment it dispatches, and this is the defense against that race
 * inside the dispatch path itself (card 0109) — `whyNotDispatchable` (jobs/dispatchable.ts) is the
 * earlier check that keeps a flagged card from being enqueued in the first place.
 */
export type NotDispatchableReason =
    | { readonly kind: 'wrong-stage'; readonly actualStage: string }
    | { readonly kind: 'empty-scope' }
    | { readonly kind: 'unsatisfied-dependency'; readonly outstanding: string[] }
    | { readonly kind: 'needs-human' }
    /** A `remote` stage found no host free, or an `any` stage found them all busy. Deferred, not poisoned. */
    | { readonly kind: 'no-host' }
    /** A stage that runs here found every `local-stage-slots` slot held. Deferred, not poisoned. */
    | { readonly kind: 'no-local-slot' };

/** Aborts a transition's write, leaving the card as it is: it left the stage the run started in. */
class CardMovedDuringRunError extends Error {
    constructor(readonly actualStage: string) {
        super(`card moved to "${actualStage}" during the run`);
    }
}

/**
 * Thrown by `assertDispatchable` in place of a bare `Error`.
 *
 * None of its conditions is a provider hiccup or a dropped connection, so retrying is a
 * slower route to the same answer. `isPermanentFailure`'s message-text matching exists because the
 * SDK and the provider give it nothing better; that reasoning does not extend to an error this
 * codebase throws itself, so this carries a typed `reason` instead of adding a pattern. The message
 * text is unchanged from the errors this replaces — it is what an operator reads.
 */
export class NotDispatchableError extends Error {
    constructor(
        public readonly reason: NotDispatchableReason,
        message: string,
    ) {
        super(message);
        this.name = 'NotDispatchableError';
    }
}

/**
 * Thrown when `WorktreeManager.rebaseOntoHead` reports a genuine conflict.
 *
 * A conflict is a fact about the board's scheduling — two branches touched the same lines — not a
 * judgment about this card's code, which has not even run yet. It is also not something a retry
 * fixes: the same two branches conflict identically on every attempt. `rebaseOntoHead` already knows
 * this (its own doc comment says so) and aborts rather than leaving a half-rebased worktree behind;
 * this carries that knowledge out as a type, the way `NotDispatchableError` does for
 * `assertDispatchable`'s refusals, so `CardStageJob` routes it on a discriminant instead of falling
 * through to `isPermanentFailure`'s message matching (which is tuned for provider errors, not this
 * codebase's own).
 *
 * `message` is composed once, here, so there is a single place that turns "a rebase conflicted" into
 * the one sentence an operator needs: what to do about it. `branch`, `targetSha` and `detail` stay
 * available as fields so a caller can also record them structurally, without re-parsing the message.
 */
export class RebaseConflictError extends Error {
    constructor(
        public readonly branch: string,
        public readonly targetSha: string,
        public readonly detail: string,
    ) {
        super(`${detail} Rebase it onto ${targetSha.slice(0, 8)} by hand, then run \`wilson card start\`.`);
        this.name = 'RebaseConflictError';
    }
}

/** The stage's own summary, for the commit message body. */
const describe = (result: unknown): string => {
    const summary = (result as { summary?: string } | undefined)?.summary;
    return summary && summary.trim().length > 0 ? summary.trim() : 'No summary reported.';
};

/** The findings a review carries, when its result carries any. Other stages report none. */
const findingsFrom = (result: unknown): ReviewFinding[] | undefined => {
    const findings = (result as { findings?: unknown } | undefined)?.findings;
    return Array.isArray(findings) ? (findings as ReviewFinding[]) : undefined;
};

/** The criteria statuses a review carries, when its result carries any. Other stages report none. */
const criteriaFrom = (result: unknown): ReviewCriterion[] | undefined => {
    const criteria = (result as { criteria?: unknown } | undefined)?.criteria;
    return Array.isArray(criteria) ? (criteria as ReviewCriterion[]) : undefined;
};

/**
 * Folds collateral writes into the stage's own caveats.
 *
 * A `scope.collateral` event records the widening for the audit trail, but the event log is not
 * where the review looks for what to check — the reported result is. Without this, "recorded" would
 * mean only a log entry nobody reads before the review runs.
 */
const withCollateralCaveats = (outcome: StageOutcome, collateral: string[]): StageOutcome => {
    if (collateral.length === 0) return outcome;
    const result = outcome.result as { caveats?: unknown } | undefined;
    if (!result || !Array.isArray(result.caveats)) return outcome;

    return {
        ...outcome,
        result: {
            ...result,
            caveats: [
                ...result.caveats,
                ...collateral.map(path => `wrote ${path} as collateral: not itself in scope, but a file something in scope imports`),
            ],
        },
    };
};

/**
 * Run one stage for one card.
 *
 * Takes a stage config object even though exactly one stage is configured, because that is the seam
 * that keeps "stages are config, not code" true when the testing stage lands as card one.
 *
 * The runner is the sole writer of transitions (PROJECT.md decision 5): an agent stage that
 * finishes moves the card itself, forward on a pass or back on a kickback. A `manual` stage is a
 * human gate the runner leaves alone.
 */
@Injectable()
export class StageDispatcher {
    // `settings`/`portAllocator` are optional for the same reason `WorktreeManager`'s own `leases`
    // constructor param is (`worktree.manager.ts`): most of this class's own tests, and several
    // others across the suite, construct it directly rather than through DI, one positional argument
    // at a time. Card 0027 added these two after every one of those call sites already existed;
    // requiring them would break each at the type level for tests this card is told not to touch
    // ("Do not write tests; the testing stage adds them"). Left undefined, the port-allocation step
    // below is skipped entirely — the same "nothing to do" outcome a card with no worktree already
    // gets. Production wiring (`stages.module.ts`'s `useClass`) always supplies both via DI.
    constructor(
        private readonly config: BoardConfig,
        private readonly stageConfigs: StageConfigStore,
        private readonly board: BoardRepository,
        private readonly worktrees: WorktreeManager,
        private readonly agents: StageAgentMap,
        private readonly verifiers: StageVerifierMap,
        private readonly resultSchemas: StageResultSchemaMap,
        private readonly events: EventLog,
        private readonly logger: Logger,
        private readonly settings?: SettingsStore,
        private readonly portAllocator?: DevServerPortAllocator,
        // Optional for the same reason `settings`/`portAllocator` above are: most of this class's
        // own tests construct it directly, one positional argument at a time, and a new required
        // param would break every one of those at the type level. Left undefined, the newest
        // document resolves to `''` below — the same "no learnings" outcome an empty document
        // reaches — so a test that supplies none behaves exactly as it did before this card.
        // Production wiring (`stages.module.ts`'s `useClass`) always supplies the real one.
        private readonly learnings?: LearningsStore,
        // Optional for the reason the three above are. Left undefined, every stage runs on this
        // machine whatever its `placement` says, which is how every stage ran before hosts existed.
        private readonly placer?: HostPlacer,
        // Optional for the reason the four above are. Left undefined, a refusal routes as it always
        // has, which is also what `AUTO_SPLIT_ENABLED` being off does.
        private readonly autoSplitter?: AutoSplitter,
    ) {}

    /** `interrupted` names the tree a shutdown left, for a stage being sent again after one. */
    async run(cardId: string, stageName: string, interrupted?: InterruptedAttempt, stepName?: string): Promise<StageOutcome> {
        const stages = await this.stageConfigs.load();
        const stage = findStage(stages, stageName, stepName);

        // Two reads answer two different questions about this card, and conflating them was card
        // 0109's bug: `head` is the live row — stage, retries, needsHuman, dependsOn — the runner
        // state that describes where the card actually is right now and moves independently of the
        // plan. `card` is the plan contract — title, "Files in scope", body — read at its approved
        // version, not the newest one, so an edit landing on the board while this stage runs cannot
        // retroactively change the contract the running agent is working to. Every read below is one
        // or the other, never a mix: `assertDispatchable` takes both and keeps them straight;
        // `materializePlan` and `filesInScope` stay on `card`; `writeTransition`/`refuseOverBudget`'s
        // retries and needsHuman stay on `head` — and so does the card's branch (card 0095): it is
        // runner state set by a previous dispatch, not part of the plan contract, so `card`'s pinned
        // snapshot from before that dispatch would never see it.
        const head = await this.board.read(cardId);
        const pinnedSha = head.frontmatter.planVersionId;
        const card = pinnedSha ? await this.board.readAt(cardId, pinnedSha) : head;
        if (!pinnedSha) {
            this.logger.warn(`card ${cardId} has no approved plan version; running against current state`);
        }

        const boardCards = await this.board.list();
        this.assertDispatchable(head, card, stage, boardCards);

        // Checked before any worktree is cut, not after: an over-budget card must not cut a tree,
        // install dependencies or reach a model. Absent `maxCardInputTokens` means unbounded, so
        // this reads the card's total spend only when a cap is actually configured.
        if (stage.maxCardInputTokens !== undefined) {
            const spent = await this.events.totalInputTokens(this.config.project, cardId);
            const message = cardOverBudget(spent, stage.maxCardInputTokens);
            if (message) {
                return this.refuseOverBudget(cardId, stageName, head, card, spent, stage.maxCardInputTokens, message);
            }
        }

        // Before any worktree is cut: where it is cut is the placement. A stage waiting on a host is
        // deferred, the same "not now" an unsatisfied dependency is.
        // An interrupted stage goes back to its tree: one on this machine skips placement altogether.
        const stayHere = interrupted !== undefined && interrupted.host === undefined;
        const placed = this.placer && !stayHere ? await this.placer.place(this.config.project, cardId, stage, interrupted?.host) : undefined;
        if (placed instanceof NoHostAvailable) {
            throw new NotDispatchableError({ kind: 'no-host' }, `${cardId} ${stageName} is waiting for a host: ${placed.message}`);
        }
        // Stage config refuses what would send an isolated stage here. This holds whatever else is true:
        // no placer, as under `wilson card run`, or an interrupted attempt with no host.
        if (!placed && stage.isolated) {
            throw new NotDispatchableError({ kind: 'no-host' }, `${cardId} ${stageName} is isolated, and would have run on this machine`);
        }
        if (!placed) {
            // A stage with no tree takes no slot: a slot is a worktree, an install and an agent here.
            if (!this.placer || stage.worktree === 'none') {
                return this.runCut({ cardId, stageName, stages, stage, head, card, pinnedSha, boardCards, interrupted });
            }
            const slot = await this.placer.takeLocalSlot(this.config.project, cardId);
            if ('busy' in slot) {
                throw new NotDispatchableError(
                    { kind: 'no-local-slot' },
                    `${cardId} ${stageName} runs on this machine, and all ${slot.busy} of its local-stage-slots are in use`,
                );
            }
            try {
                return await this.runCut({ cardId, stageName, stages, stage, head, card, pinnedSha, boardCards, interrupted });
            } finally {
                await this.placer.releaseSlot(slot.key, this.config.project, cardId).catch(err => {
                    this.logger.warn(`could not release ${cardId}'s ${slot.key}: ${(err as Error).message}`);
                });
            }
        }

        // A stage on a host gives its worktree and slot back as soon as it ends, however it ends:
        // the branch has already been fetched back if it passed, and anything uncommitted is saved
        // to this machine's patch path, so nothing the next stage needs is left on the host. A slot
        // held past its stage would keep the next card off a host with nothing running on it. An
        // interrupted stage is the exception: its tree stays for the attempt sent after it, and only
        // the slot goes back.
        let keepWorktree = false;
        await this.events.append({
            project: this.config.project,
            cardId,
            stage: stageName,
            type: 'stage.placed',
            payload: { host: placed.hostName, slot: placed.slotKey, ...(stage.step ? { step: stage.step } : {}) },
        });
        try {
            return await this.runCut({ cardId, stageName, stages, stage, head, card, pinnedSha, boardCards, placement: placed, interrupted });
        } catch (err) {
            if (err instanceof StageInterruptedError) {
                keepWorktree = true;
                throw err;
            }
            // Anything thrown on a host, from cutting the worktree to the commit, may be the host
            // going away rather than the stage going wrong. Only a host that no longer answers turns
            // it into a retry; one that answers leaves the error to mean what it says.
            if (err instanceof HostLostError) throw err;
            await this.throwIfHostLost(placed, cardId, stageName, (err as Error).message, err);
            throw err;
        } finally {
            if (!keepWorktree) {
                await this.worktrees.reclaim(cardId, placed).catch(err => {
                    this.logger.warn(`could not reclaim ${cardId}'s worktree on ${placed.hostName}: ${(err as Error).message}`);
                });
            }
            // The slot outlives the worktree by a moment on purpose: until the host's tree is gone,
            // the host is still busy with this card.
            await this.placer?.releaseSlot(placed.slotKey, this.config.project, cardId).catch(err => {
                this.logger.warn(`could not release ${cardId}'s ${placed.slotKey}: ${(err as Error).message}`);
            });
        }
    }

    /**
     * The last look before a passing stage commits, whatever engine ran it and whatever its verifier
     * checked. Everything uncommitted must be in this stage's scope, since a command or an engine can
     * write without asking a guard. And it must be what the verifier saw: an engine can land an edit
     * after the verifier finished (see `tool.unguarded`), and committing that would record a verdict
     * on work nobody judged. `testReportPath` is exempt from scope, being the runner's own output.
     */
    private async checkBeforeCommit(outcome: StageOutcome, worktree: Worktree, scope: ScopeGuard, stage: StageConfig): Promise<StageOutcome> {
        const failures: string[] = [];
        for (const path of await this.worktrees.uncommittedPaths(worktree)) {
            if (path === stage.testReportPath) continue;
            const decision = await scope.check(path);
            if (!decision.allowed) failures.push(`${path} is outside this stage's scope (${decision.reason})`);
        }
        if (outcome.verifiedTree) {
            const drifted = snapshotDrift(outcome.verifiedTree, await this.worktrees.uncommittedSnapshot(worktree));
            if (drifted.length > 0) failures.push(`changed after the stage was verified: ${drifted.join(', ')}`);
        }
        return failures.length === 0 ? outcome : { ...outcome, passed: false, failures: [...outcome.failures, ...failures] };
    }

    /**
     * `run` from the worktree on: cut it (on `placement`'s host when there is one), prepare it, run
     * the stage and record what happened. Split from `run` so a placed stage's cleanup wraps all of
     * this, including a rebase conflict or a failed setup, in one `finally`.
     */
    private async runCut(input: {
        cardId: string;
        stageName: string;
        stages: ProjectStages;
        stage: StageConfig;
        head: Card;
        card: Card;
        pinnedSha: string | undefined;
        boardCards: Card[];
        placement?: RemotePlacement;
        interrupted?: InterruptedAttempt;
    }): Promise<StageOutcome> {
        const { cardId, stageName, stages, stage, head, card, pinnedSha, boardCards, placement, interrupted } = input;
        const branch = this.worktrees.resolveBranch(head);

        // Only where the tree actually is. Placed anywhere else, the stage cuts one as usual, and the
        // left-behind tree's uncommitted work is saved whenever that host next reclaims the card.
        const reopened =
            interrupted && interrupted.host === placement?.hostName
                ? await this.worktrees.reopen(cardId, branch, interrupted.baseSha, placement)
                : undefined;

        // `base` means "start fresh if there is nothing to resume", not "always discard". A card
        // kicked back from review carries findings citing file:line on its own branch; rebuilding
        // from scratch throws away the work those findings are about, and any tests a later stage
        // already wrote. Since only a passing stage commits, a branch carrying work is by
        // construction the last state that satisfied an exit condition, so resuming is always safe.
        const resumable = stage.worktreeFrom === 'branch' || (await this.worktrees.hasWork(branch));
        let worktree =
            reopened ??
            (placement
                ? resumable
                    ? await this.worktrees.resume(cardId, branch, placement)
                    : await this.worktrees.create(cardId, branch, undefined, placement)
                : resumable
                  ? await this.worktrees.resume(cardId, branch)
                  : await this.worktrees.create(cardId, branch));

        // A resumed branch may be many merges behind. Left alone the stage implements against a tree
        // that no longer matches main, and neither its exit condition nor the review can distinguish
        // "this does not exist" from "this does not exist here". A reopened tree holds uncommitted
        // work a rebase would refuse, and is rebased when it next starts from its branch.
        if (resumable && !reopened) {
            const rebased = await this.worktrees.rebaseOntoHead(worktree);
            if (!rebased.ok) {
                // Not thrown as a bare Error: a conflict is not this card's code failing, and
                // `CardStageJob` needs a discriminant to route it to a flag instead of a retry.
                const targetSha = await this.worktrees.headSha();
                throw new RebaseConflictError(branch, targetSha, rebased.reason);
            }
            worktree = { ...worktree, baseSha: rebased.baseSha };
        }
        await this.events.append({
            project: this.config.project,
            cardId,
            stage: stageName,
            type: 'worktree.created',
            payload: { branch, baseSha: worktree.baseSha, path: worktree.path, ...(placement && { host: placement.hostName }) },
        });

        // Recorded only now, after the worktree above has actually landed — a branch recorded for a
        // worktree that failed to cut would be a lie the next run would then prefer. Gated on `head`,
        // which reflects every dispatch since approval, not on `card`'s pinned snapshot from before
        // all of them; skipped entirely once `head` already carries one, so a card gets this one
        // extra version at most once, on whichever dispatch is its first. The event above already
        // carries the branch, so this is a plain `write`, not `writeWithEvent`. The mutate callback
        // re-checks `current.frontmatter.branch` itself — `BoardRepository.write` re-reads inside its
        // own transaction, so that inner check is what actually guards against a concurrent write; the
        // `head` check above only saves the common case a round trip to the database.
        if (!head.frontmatter.branch) {
            await this.board.write(cardId, `${cardId}: recorded branch ${branch}`, current =>
                current.frontmatter.branch ? current : { ...current, frontmatter: { ...current.frontmatter, branch } },
            );
        }

        // Card 0027. Acquired here, once the worktree above has actually landed, and before either
        // `setupCommand` (just below) or the agent's own bash tool sees the tree — both read
        // `scrubbedEnv`'s `PORT` (`run.command.ts`/`bash.tool.ts`), so a dev server either of them
        // starts must see the same one. `WorktreeManager.reclaimUnlocked` (card 0165) already
        // releases every lease this card holds on every route that ends its worktree, this card's own
        // Constraints leave that side untouched — so nothing frees this port explicitly here.
        //
        // Off unless `DEV_SERVER_PORT_RANGE` is configured: `range` is `undefined` on a fresh
        // deployment, exactly `CARD_STAGE_CONCURRENCY`'s own "unset environment resolves to the coded
        // default" shape, and `port` then stays `undefined` all the way through — no lease row, no
        // `PORT`, identical to every dispatch before this card. A `worktree: none` stage has no tree
        // to bind a dev server in, so it takes no lease at all, configured range or not.
        let port: number | undefined;
        // A port lease is a port on this machine; a host's ports are its own, and nothing here
        // allocates them, so a placed stage takes none.
        if (stage.worktree !== 'none' && !placement && this.settings && this.portAllocator) {
            const range = await this.settings.get(DEV_SERVER_PORT_RANGE);
            if (range) {
                const allocation = await this.portAllocator.acquire(range, this.config.project, cardId);
                if (!allocation.ok) {
                    throw new Error(`could not allocate a dev server port for ${cardId}: ${allocation.reason}`);
                }
                port = allocation.port;
                this.logger.info(`${cardId} ${stageName} allocated dev server port ${port}`);
            }
        }

        const { planPath, learningsPath, scoped, scope } = await prepareStage(
            {
                config: this.config,
                worktrees: this.worktrees,
                events: this.events,
                logger: this.logger,
                learnings: this.learnings,
            },
            { cardId, stageName, stages, stage, card, pinnedSha, worktree, placement, port, boardCards },
        );

        await this.events.append({
            project: this.config.project,
            cardId,
            stage: stageName,
            type: 'stage.dispatched',
            payload: { provider: stage.provider, model: stage.model, planPath, scope: scoped, ...(pinnedSha ? { planVersionId: pinnedSha } : {}) },
        });

        let outcome: StageOutcome;
        try {
            const ran = await this.runAgent({
                card,
                stage,
                worktree,
                scope,
                planPath,
                learningsPath,
                stages,
                port,
                ...(reopened && { interrupted }),
            });

            // A write is allowed as collateral without a `request_scope` round trip, but it is still
            // a widening — reported here, always, so the review sees it and a stage can never widen
            // its own scope silently (PROJECT.md, Scope enforcement).
            const collateralHits = scope.collateralHits();
            for (const path of collateralHits) {
                await this.events.append({
                    project: this.config.project,
                    cardId,
                    stage: stageName,
                    type: 'scope.collateral',
                    payload: { path },
                });
            }
            outcome = withCollateralCaveats(ran, collateralHits);

            // A stage that failed on a host whose engine or tools lost their connection failed for
            // a reason that is not the card's. Checked before anything is committed or transitioned,
            // so a lost host never costs the card a kickback.
            if (placement && !outcome.passed) {
                await this.throwIfHostLost(placement, cardId, stageName, outcome.failures.join('; ') || 'the stage did not pass');
            }

            if (outcome.passed) outcome = await this.checkBeforeCommit(outcome, worktree, scope, stage);

            // Only a passing stage commits. A failed stage leaves its work in the worktree for
            // inspection, and the next attempt starts from the base rather than building on a tree
            // that did not satisfy its exit condition.
            if (outcome.passed) {
                const sha = await this.worktrees.commit(worktree, `${cardId}: ${stageName}\n\n${describe(outcome.result)}`);
                // Before the transition below is written: a stage recorded as passed on a host must
                // have its work here, where the next stage and the merge will look for it.
                if (sha && worktree.placement) await this.worktrees.fetchBack(worktree);
                if (sha) {
                    await this.events.append({
                        project: this.config.project,
                        cardId,
                        stage: stageName,
                        type: 'work.committed',
                        payload: { sha, branch },
                    });
                    this.logger.info(`committed ${sha.slice(0, 8)} to ${branch}`);
                }
            }

            // Only a failed stage leaves uncommitted work behind for `reclaim` to preserve, and the
            // path is deterministic from the card id alone — naming it here does not depend on
            // `reclaim` having actually run yet (card 0089: preservation happens lazily, at the
            // next `create`/`resume`/`reclaim`, not at the failure site).
            if (!outcome.passed) {
                this.logger.warn(
                    `${cardId} ${stageName} failed with work still in the worktree; if anything is uncommitted, reclaim will save it to ${this.worktrees.failedAttemptPatchPath(cardId)}`,
                );
            }
            await this.events.append({
                project: this.config.project,
                cardId,
                stage: stageName,
                type: outcome.passed ? 'stage.passed' : 'stage.failed',
                payload: {
                    ...(stage.step ? { step: stage.step } : {}),
                    failures: outcome.failures,
                    changedPaths: outcome.changedPaths,
                    grants: outcome.scopeGrants,
                    usage: outcome.usage,
                    // The result itself, not just its shape. A review's findings *are* the output of
                    // the stage; recording only that it passed throws away the thing it produced.
                    result: outcome.result ?? null,
                    ...(outcome.trace ? { trace: outcome.trace } : {}),
                    ...(outcome.passed
                        ? {}
                        : {
                              patchPath: this.worktrees.failedAttemptPatchPath(cardId),
                              // Alongside `failures`/`usage`, not a new event (card 0118): the engine's
                              // own account of why it ended, when it said anything at all. Absent when
                              // `outcome.engineStopReason` is — a run whose `result` message never
                              // arrived, where the SDK told the adapter nothing to carry here.
                              ...(outcome.engineStopReason ? { engineStopReason: outcome.engineStopReason } : {}),
                          }),
                },
            });
        } catch (err) {
            if (err instanceof StageInterruptedError) {
                await this.events.append({
                    project: this.config.project,
                    cardId,
                    stage: stageName,
                    type: 'stage.interrupted',
                    payload: { usage: err.usage, ...(err instanceof StageHeldError && { usageLimit: err.limit, heldUntil: err.heldUntil }) },
                });
                throw err;
            }
            const reason = err instanceof ScopeKickbackError ? err.message : (err as Error).message;
            const patchPath = this.worktrees.failedAttemptPatchPath(cardId);
            this.logger.warn(
                `${cardId} ${stageName} failed with work still in the worktree; if anything is uncommitted, reclaim will save it to ${patchPath}`,
            );
            await this.events.append({
                project: this.config.project,
                cardId,
                stage: stageName,
                type: 'stage.failed',
                payload: { error: reason, patchPath },
            });
            throw err;
        }

        if (stage.mode !== 'agent') {
            return outcome;
        }

        // Outside the try above, and in its own: the stage's outcome is already recorded, and a
        // transition that fails to write must not be reported as the stage having failed. Sharing
        // the catch would append a `stage.failed` event after a `stage.passed` one for the same
        // run, leaving the card's history contradicting itself about what the stage did.
        let transitionedTo: string | undefined;
        let nextStep: string | undefined;
        let needsHuman = false;
        let splitInto: string[] | undefined;
        try {
            const transition = await this.writeTransition(cardId, stageName, stage, head, card, outcome);
            transitionedTo = transition.target;
            nextStep = transition.nextStep;
            needsHuman = transition.needsHuman;
            splitInto = transition.splitInto;
        } catch (err) {
            await this.events.append({
                project: this.config.project,
                cardId,
                stage: stageName,
                type: 'transition.failed',
                payload: { error: (err as Error).message, outcome: outcome.passed ? 'passed' : 'failed' },
            });
            // Still thrown: the card is now stranded in a stage whose work is done, and a
            // silent failure here is how a card sits untouched forever.
            throw err;
        }
        return { ...outcome, transitionedTo, ...(nextStep && { nextStep }), needsHuman, ...(splitInto && { splitInto }) };
    }

    /**
     * Move the card: forward on a pass, back on a kickback, and record why either way.
     *
     * The runner is the sole writer of card state (PROJECT.md decision 5). The move and the
     * `transition.written` event that records it go through `writeWithEvent`, so they commit
     * together — a card cannot end up moved with no event, or an event describing a move that did
     * not happen. A failure here is not swallowed: the stage's own `stage.passed`/`stage.failed`
     * event is already recorded, but a transition that did not happen must surface, so this throws.
     */
    private async writeTransition(
        cardId: string,
        stageName: string,
        stage: StageConfig,
        head: Card,
        card: Card,
        outcome: StageOutcome,
    ): Promise<{ target?: string; nextStep?: string; needsHuman: boolean; splitInto?: string[] }> {
        // Before any routing: a split replaces the kickback rather than following it, and when it
        // declines the card routes exactly as it would have. A card whose ticket closed mid-run is
        // left to the halt below: nobody wants its work divided up.
        if (outcome.supportedRefusal && this.autoSplitter && !head.frontmatter.sourceClosed) {
            const split = await this.autoSplitter.split(cardId, stageName, outcome.supportedRefusal);
            if (split) return this.finishAutoSplit(cardId, stageName, card, split.pieceIds);
        }

        // `retries` and `needsHuman` come from `head`, not `card`: both are runner state, and `card`
        // is frozen at approval — a retry count read from it would forget every attempt made since,
        // and a flag read from it would look unset even after the card was flagged post-approval.
        //
        // A `revise` the lane has a step for is not a kickback yet: the step tests it first, in a fresh
        // context, and the card stays put until the step has spoken. Not for a card whose ticket closed
        // mid-run, which the halt below deals with.
        const revised = !stage.step && outcome.passed && !shouldAdvance(outcome.passed, outcome.result);
        const reviseStep = revised && !head.frontmatter.sourceClosed ? stage.steps?.find(step => step.on === 'revise') : undefined;
        let decision: KickbackDecision = reviseStep
            ? { target: stageName, retries: head.frontmatter.retries }
            : shouldAdvance(outcome.passed, outcome.result)
              ? { target: stage.onPass, retries: head.frontmatter.retries }
              : kickback(stage, head.frontmatter.retries, Boolean(outcome.unjudged), Boolean(outcome.resultDropped));
        decision = { ...decision, target: endingOf(decision.target) };

        // A plan check that says no leaves the card in planning, wherever the lane's own failures go:
        // the person who approved it decides what happens next.
        const planCheck = isPlanCheck(stage);
        const advanced = shouldAdvance(outcome.passed, outcome.result);
        const refused = planCheck && !advanced && !outcome.unjudged && !outcome.resultDropped;
        if (planCheck && !advanced) decision = { ...decision, target: stageName };

        // Card 0200: a card whose ticket closed externally while this stage was running halts here
        // instead of advancing or kicking back further, once this one stage — already bounded by its
        // own budget — finishes. `InboundCardWriter` is what set the flag going in; this is the one
        // place that flag turns into "stop". Only overrides when the ordinary decision did not
        // already flag one: an exhausted kickback's own reason must not be replaced by this one.
        if (head.frontmatter.sourceClosed && !decision.needsHuman) {
            decision = { target: stageName, retries: decision.retries, needsHuman: { reason: 'source-closed' } };
        }

        // Findings from a result the verifier rejected (`outcome.passed === false`) are not evidence:
        // a hallucinated file, an out-of-range line, or a verdict contradicting its severities can all
        // still carry findings, and writing those into the body would hand the next retry a rejected
        // review's claims as if they were trustworthy. Only a passed outcome's findings are folded in.
        // Nor a `revise` still waiting on its step: the step's report is the one that counts.
        const findings = outcome.passed && !reviseStep ? findingsFrom(outcome.result) : undefined;
        // Same "only a passed outcome's data is trustworthy" reasoning as `findings` above: criteria
        // from a result the verifier rejected are not evidence either.
        const criteria = outcome.passed && !reviseStep ? criteriaFrom(outcome.result) : undefined;
        const needsHuman = decision.needsHuman;
        // A step sent round again (a report it could not stand behind, an engine cut off) is that step
        // again, not the lane's own run.
        const nextStep =
            needsHuman || refused ? undefined : (reviseStep?.name ?? (stage.step && decision.target === stageName ? stage.step : undefined));

        // Only a judgment about the work earns a bullet. `unjudged` (a step/wall-clock/token cutoff,
        // an engine that stopped responding, a missing or unparseable result) and `resultDropped` (the
        // stage did report and the transport lost it) are both infrastructure, not a statement about
        // the work — retrying repeats the same attempt, so there is nothing here worth telling the next
        // attempt about. `decision.retries[stageName]` is safe to read unconditionally here: a judged
        // failure is exactly the branch of `kickback` that sets it, to the attempt count this failure
        // just reached.
        const judgedFailure = !outcome.passed && !outcome.unjudged && !outcome.resultDropped;
        // `preserveUncommitted` (worktree.manager.ts) only ever writes a patch when the worktree is
        // actually dirty at reclaim time — a judged failure that left nothing uncommitted (the review
        // verifier's own "the card has an empty diff", the Goal's motivating example) has no patch to
        // point the next attempt at. `outcome.changedPaths` is `git diff baseSha` plus untracked files,
        // computed against the same working tree `preserveUncommitted` will later `git status` before
        // this stage has committed anything (only a pass commits, so a failing stage's branch never
        // moves between attempts) — so an empty list here means an empty `git status` there too, and a
        // non-empty one means the patch this bullet names will actually exist.
        const attempt: Attempt | undefined = judgedFailure
            ? {
                  stage: stageName,
                  attempt: decision.retries[stageName] ?? 0,
                  maxKickbacks: stage.maxKickbacks,
                  date: new Date().toISOString(),
                  failures: outcome.failures,
                  summary: describe(outcome.result),
                  engineStopReason: outcome.engineStopReason,
                  ...(outcome.changedPaths.length > 0 ? { patchPath: this.worktrees.failedAttemptPatchPath(cardId) } : {}),
              }
            : undefined;

        // A body this transition rewrote is the plan contract, not just runner state, and the runner
        // rewriting its own contract is the one case where a pin moves. Left where it was, it would
        // name a version from before the very findings or attempt bullet the next run has to read
        // (card 0091: three implementing passes reading a plan with no findings section). Decided
        // inside the mutate, from `current`: a card with no pin coming in gets none out, and a human
        // editing the body between runs must not move it.
        let advancesPin = false;

        try {
            await this.board.writeWithEvent(
                cardId,
                `${cardId}: ${stageName} -> ${decision.target}`,
                current => {
                    // `current` is read under the row lock, so this is the check `head` cannot make: a
                    // human who moved the card while this stage ran has the last word, and this
                    // transition, decided from the stage the run started in, must not undo that.
                    if (current.frontmatter.stage !== stageName) throw new CardMovedDuringRunError(current.frontmatter.stage);
                    // Nor may a check approve a plan a person has since changed.
                    if (planCheck && current.frontmatter.planCheck !== 'checking') throw new CardMovedDuringRunError(current.frontmatter.stage);

                    // On a pass, the section this stage may have accumulated while it kept failing is
                    // shed (the same "shed on pass" rule findings use); on a judged failure, one more
                    // bullet joins whatever is already there; any other outcome (unjudged, resultDropped)
                    // leaves the section exactly as it stands.
                    const body = outcome.passed ? withoutAttempts(current.body) : attempt ? withAttempt(current.body, attempt) : current.body;
                    const nextBody = findings ? withFindings(body, findings, criteria) : body;
                    advancesPin = nextBody !== current.body && Boolean(head.frontmatter.planVersionId && current.frontmatter.planVersionId);
                    const { planCheck: _planCheck, planCheckReason: _planCheckReason, ...unchecked } = current.frontmatter;
                    const check = planCheck
                        ? refused
                            ? {
                                  planCheck: 'refused' as const,
                                  planCheckReason: (outcome.result as { reason?: string } | undefined)?.reason ?? outcome.failures.join('; '),
                              }
                            : nextStep
                              ? { planCheck: 'checking' as const }
                              : {}
                        : { planCheck: current.frontmatter.planCheck, planCheckReason: current.frontmatter.planCheckReason };
                    return {
                        ...current,
                        frontmatter: {
                            ...unchecked,
                            ...check,
                            stage: decision.target,
                            retries: decision.retries,
                            ...(needsHuman ? { needsHuman: true, needsHumanReason: needsHuman.reason } : {}),
                        },
                        body: nextBody,
                    };
                },
                {
                    project: this.config.project,
                    cardId,
                    stage: stageName,
                    type: 'transition.written',
                    payload: {
                        from: stageName,
                        to: decision.target,
                        retries: decision.retries,
                        by: 'runner',
                        ...(needsHuman ? { needsHuman: true } : {}),
                        ...(nextStep ? { step: nextStep } : {}),
                    },
                },
                { repinIf: () => advancesPin },
            );
        } catch (err) {
            if (!(err instanceof CardMovedDuringRunError)) throw err;
            // No target: the card is where the human put it, so there is nothing to chain from, and
            // the worktree and the notification below belong to a transition that did not happen.
            await this.events.append({
                project: this.config.project,
                cardId,
                stage: stageName,
                type: 'stage.stale',
                payload: { wantedStage: stageName, actualStage: err.actualStage },
            });
            this.logger.warn(`${cardId} moved to "${err.actualStage}" while ${stageName} ran; leaving it there`);
            // `move` leaves the tree alone while this run is using it, so a card moved to a terminal
            // stage gets its worktree back here, now that the run is over.
            const reclaimed = await this.board.reclaimIfTerminal(this.worktrees, this.events, {
                project: this.config.project,
                cardId,
                stage: stageName,
                target: err.actualStage,
                flagged: Boolean(head.frontmatter.needsHuman),
            });
            if (reclaimed.error) {
                this.logger.warn(`could not reclaim worktree for ${cardId} after it moved to "${err.actualStage}": ${reclaimed.error}`);
            }
            return { needsHuman: false };
        }

        // The card's life has ended; the transition above already stands. `reclaimIfTerminal` is the
        // one place "the card is done" turns into "the worktree goes away" — shared with a human's
        // `wilson card move` so the two paths cannot drift into two definitions of done. It already
        // checks `isTerminal` and never reclaims a flagged card's tree (card 0055); a failure here is
        // logged and swallowed rather than allowed to unwind a transition that already happened.
        const reclaimed = await this.board.reclaimIfTerminal(this.worktrees, this.events, {
            project: this.config.project,
            cardId,
            stage: stageName,
            target: decision.target,
            flagged: Boolean(head.frontmatter.needsHuman) || Boolean(needsHuman),
        });
        if (reclaimed.error) {
            this.logger.warn(`could not reclaim worktree for ${cardId} after reaching "${decision.target}": ${reclaimed.error}`);
        }

        // Do not send twice for one event: skip when the card already carried the flag going into
        // this run, so a retried or redelivered job that reaches the same exhausted-kickback outcome
        // again does not re-notify for a state change already reported.
        if (needsHuman && !head.frontmatter.needsHuman) {
            await this.notify({
                cardId,
                title: card.frontmatter.title,
                stage: decision.target,
                moment: 'needs-human',
                reason: needsHuman.reason,
            });
        }

        return { target: decision.target, ...(nextStep && { nextStep }), needsHuman: needsHuman !== undefined };
    }

    /**
     * What `writeTransition` does after a transition, for the one `AutoSplitter` wrote itself: give
     * the worktree back, and tell a person the pieces are waiting. Empty `pieceIds` means another run
     * of this stage got there first and did both.
     */
    private async finishAutoSplit(
        cardId: string,
        stageName: string,
        card: Card,
        pieceIds: string[],
    ): Promise<{ target: string; needsHuman: boolean; splitInto?: string[] }> {
        const target = 'split';
        if (pieceIds.length === 0) return { target, needsHuman: false };

        const reclaimed = await this.board.reclaimIfTerminal(this.worktrees, this.events, {
            project: this.config.project,
            cardId,
            stage: stageName,
            target,
            flagged: false,
        });
        if (reclaimed.error) {
            this.logger.warn(`could not reclaim worktree for ${cardId} after reaching "${target}": ${reclaimed.error}`);
        }

        await this.notify({
            cardId,
            title: card.frontmatter.title,
            stage: target,
            moment: 'auto-split',
            reason: `split into ${pieceIds.join(', ')}, which wait in planning for their plans to be approved`,
        });
        return { target, needsHuman: false, splitInto: pieceIds };
    }

    /**
     * A card that has already spent its configured ceiling is flagged for a human without the
     * stage running at all — retrying cannot fix it, since the next attempt would spend the same
     * budget again, and a retry budget is for work that came back wrong, not work that cannot be
     * afforded. Unlike `poisoned`, this is not an infrastructure failure the queue should stop
     * retrying forever: it is the same "stay where it failed, flagged" outcome an exhausted
     * kickback reaches, just reached before the stage ever ran.
     *
     * The flag is written through the same `writeWithEvent` mutate that a kickback exhaustion
     * uses, so the flag and the record of why commit together. `stage` is left untouched — the
     * card never ran, so it never attempted the stage — and so are retry counters. The worktree is
     * left alone too: reclaiming it here was the old terminal-state behaviour, and flagged cards
     * now keep their worktrees on purpose, so a person looking into the flag has something to look
     * at. Nothing collects those trees; that is the deliberate cost of this design.
     */
    private async refuseOverBudget(
        cardId: string,
        stageName: string,
        head: Card,
        card: Card,
        spent: number,
        cap: number,
        message: string,
    ): Promise<StageOutcome> {
        await this.events.append({
            project: this.config.project,
            cardId,
            stage: stageName,
            type: 'card.over-budget',
            payload: { spent, cap },
        });

        await this.board.writeWithEvent(
            cardId,
            `${cardId}: ${stageName} flagged for a human (over budget)`,
            current => ({
                ...current,
                frontmatter: { ...current.frontmatter, needsHuman: true, needsHumanReason: message },
            }),
            {
                project: this.config.project,
                cardId,
                stage: stageName,
                type: 'transition.written',
                // `retries` is runner state, read from `head`, not the plan-contract snapshot `card`.
                payload: { from: stageName, to: stageName, retries: head.frontmatter.retries, by: 'runner', needsHuman: true },
            },
        );

        // Do not send twice for one event: an already-flagged card refused again (a retried or
        // redelivered job re-checking the same still-over-budget card) has nothing new to report.
        // `needsHuman` is runner state, so this reads `head`, not `card`.
        if (!head.frontmatter.needsHuman) {
            await this.notify({
                cardId,
                title: card.frontmatter.title,
                stage: stageName,
                moment: 'needs-human',
                reason: message,
            });
        }

        return {
            passed: false,
            failures: [message],
            changedPaths: [],
            scopeGrants: [],
            transitionedTo: stageName,
            needsHuman: true,
        };
    }

    /**
     * Tell a person the card needs them — the `needs-human` moment of card 0050's Notification
     * work. Called after a write has already committed, never inside one (Constraints: "Fire after
     * the write"), so a notification never reports a transition that then rolled back.
     */
    private async notify(notification: Omit<CardNotification, 'project'>): Promise<void> {
        await new Notifier(this.config.notifyWebhookUrl, this.config.notifyBaseUrl, this.logger).notify({
            project: this.config.project,
            ...notification,
        });
    }

    /**
     * `head` is the live row and answers every question about runner state — needsHuman, stage,
     * dependsOn — because that is exactly what can have moved since `card` was pinned at approval.
     * `card` answers one question only, "Files in scope", because that is the plan contract pinning
     * exists to hold fixed against edits landing while a stage runs; reading it from `head` instead
     * would let such an edit widen a running stage's scope out from under it.
     */
    private assertDispatchable(head: Card, card: Card, stage: StageConfig, cards: Card[]): void {
        // Checked first and on its own, like `whyNotDispatchable` does: a card can be flagged while
        // sitting in any stage, so the refusal should say that, not describe the stage as the problem.
        if (head.frontmatter.needsHuman) {
            throw new NotDispatchableError(
                { kind: 'needs-human' },
                `card ${head.frontmatter.id} is flagged for a human and will not dispatch until it is cleared`,
            );
        }
        if (head.frontmatter.stage !== stage.name) {
            throw new NotDispatchableError(
                { kind: 'wrong-stage', actualStage: head.frontmatter.stage },
                `card ${head.frontmatter.id} is in stage "${head.frontmatter.stage}", not "${stage.name}"`,
            );
        }
        // A plan check judges the plan, so it does not wait on a dependency's code. And one whose
        // check was cancelled has nothing left to judge: a person changed the plan after approving it.
        const planCheck = isPlanCheck(stage);
        if (planCheck && head.frontmatter.planCheck !== 'checking') {
            throw new NotDispatchableError(
                { kind: 'wrong-stage', actualStage: head.frontmatter.stage },
                `card ${head.frontmatter.id} has no plan check waiting: its plan changed after it was approved`,
            );
        }
        // A hard block: file-based coordination cannot carry an in-flight API contract between two
        // running agents (PROJECT.md, dependency blocking).
        const outstanding = planCheck ? [] : unsatisfiedDependencies(head, cards);
        if (outstanding.length > 0) {
            throw new NotDispatchableError(
                { kind: 'unsatisfied-dependency', outstanding },
                `card ${head.frontmatter.id} is waiting on ${outstanding.join(', ')}`,
            );
        }
        if (filesInScope(card).length === 0) {
            throw new NotDispatchableError(
                { kind: 'empty-scope' },
                `card ${card.frontmatter.id} has an empty "Files in scope"; nothing would be writable`,
            );
        }
    }

    /**
     * Throw a `HostLostError` when `placement`'s host no longer answers, after marking it failed and
     * recording why. Returns quietly when it answers: then whatever went wrong is the stage's own.
     */
    private async throwIfHostLost(placement: RemotePlacement, cardId: string, stageName: string, reason: string, cause?: unknown): Promise<void> {
        if (!this.placer || (await this.placer.isAlive(placement))) return;
        await this.placer.markLost(placement, `${cardId} ${stageName}: ${reason}`);
        await this.events.append({
            project: this.config.project,
            cardId,
            stage: stageName,
            type: 'stage.host-lost',
            payload: { host: placement.hostName, reason },
        });
        throw new HostLostError(placement.hostName, reason, { cause });
    }

    private runAgent(input: StageExecutionInput): Promise<StageOutcome> {
        return executeStage(
            {
                project: this.config.project,
                worktrees: this.worktrees,
                agents: this.agents,
                verifiers: this.verifiers,
                resultSchemas: this.resultSchemas,
                events: this.events,
                logger: this.logger,
            },
            input,
        );
    }
}
