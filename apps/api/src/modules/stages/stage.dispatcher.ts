import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { withFindings } from '#modules/board/append.findings.js';
import { filesInScope, type Card } from '#modules/board/card.js';
import { unsatisfiedDependencies } from '#modules/board/next.card.js';
import { serializeCard } from '#modules/board/card.parser.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import { collateralPaths } from '#modules/agent/collateral.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { REPORT_TOOL, ScopeKickbackError, type ToolContext } from '#modules/agent/tools/index.js';
import { StageAgentMap } from '#modules/agent/stage.agent.js';
import { EventLog } from '#modules/events/event.log.js';
import { DevServerPortAllocator } from '#modules/lease/dev.server.port.allocator.js';
import { Notifier } from '#modules/notify/notifier.js';
import type { CardNotification } from '#modules/notify/notification.js';
import { DEV_SERVER_PORT_RANGE } from '#modules/settings/dev.server.port.range.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { cardOverBudget } from './card.budget.js';
import { kickback, shouldAdvance, type KickbackDecision } from './kickback.js';
import { pnpmStoreLock, runConfiguredCommand } from './run.command.js';
import { findStage, type ProjectStages, type StageConfig } from './stage.config.js';
import { StageConfigStore } from './stage.config.store.js';
import { StageResultSchemaMap, type ReviewFinding, type StageOutcome } from './stage.result.js';
import { StageVerifierMap } from './stage.verifier.js';

/**
 * Which of `assertDispatchable`'s conditions fired, carried on the error it throws.
 *
 * All of them are deterministic against a fixed card — retrying changes nothing — but they are not
 * all the same kind of "never". Wrong stage and empty scope require a human to change the card
 * before any attempt can succeed. `needs-human` is the same shape: the flag has to be acknowledged
 * before the card moves. An unsatisfied dependency is "not now", not "never": the dependency landing
 * makes the card dispatchable again with no change to the card itself. `CardStageJob` branches on
 * this discriminant, not the message text, to route each case correctly — and a variant added here
 * without a branch there falls to its default, which is `poison()`. That is how card 0109's own
 * first pass turned a flagged card into a terminal one; add the route with the variant.
 *
 * `wrong-stage` carries `actualStage` so a caller can tell a card genuinely in the wrong place
 * (card 0044's bug) from a stale job arriving after the card already reached a terminal stage
 * (card 0084) — the same distinction `isTerminal` draws everywhere else.
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
    | { readonly kind: 'needs-human' };

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

/**
 * The `extraScope` the running stage may itself write, beyond this card's own "Files in scope" —
 * the fact `materializePlan` folds into that stage's own plan so it knows what it can already
 * write, instead of calling `request_scope` for paths `ScopeGuard`'s allow list (`scoped` in `run`,
 * above) already covers.
 *
 * `ScopeGuard` is built from `[...filesInScope(card), ...stage.extraScope]`, but that allow list
 * lives inside the guard — nothing the agent reads ever names it. A plan that lists only the card's
 * own "Files in scope" and says nothing about `extraScope` reads as "everything else is out of
 * bounds," which is exactly what led card 0154's testing stage to request and be granted four test
 * files its own `*.test.ts` glob already allowed.
 *
 * Deliberately a separate note from `otherStagesScopeNote`, not folded into one list: that one tells
 * a reviewer "a file here is another stage doing its job"; this one tells the running stage "you may
 * write these yourself." Merging them would leave a reader guessing which sense applied to which
 * line.
 *
 * Returns the empty string when this stage configures no `extraScope`, so a stage with none gets no
 * heading and no dangling sentence, matching `otherStagesScopeNote`.
 */
const ownScopeNote = (stage: StageConfig): string => {
    if (stage.extraScope.length === 0) return '';

    return [
        '## Your scope',
        '',
        'Beyond this card\'s own "Files in scope" above, this stage may also write, under its own',
        'configured scope:',
        '',
        ...stage.extraScope.map(g => `- \`${g}\``),
    ].join('\n');
};

/**
 * The paths another stage may add on top of this card's own "Files in scope" — the fact
 * `materializePlan` folds into every stage's plan so a file a later stage legitimately adds under
 * its own `extraScope` (`stage.config.ts`) reads as expected, not as undeclared scope creep.
 *
 * A card's "Files in scope" is written for `implementing`; nothing else about the pipeline is in
 * that document, so a stage reading only the plan has no way to tell a test file the testing stage
 * added under its own `extraScope` apart from one that was never declared at all (card 0139).
 *
 * Generated from the loaded `stages.yaml`, not duplicated here as a second copy of it: a project
 * that configures different globs, or a different stage entirely, gets those globs with no code
 * change. Excludes the stage this plan is being materialized for — not because restating it would
 * say nothing new (`ScopeGuard`'s allow list enforces that stage's own `extraScope` but never shows
 * it to the agent, which is exactly why `ownScopeNote`, above, exists), but because it is a different
 * fact for a different reader: this list tells a reviewer "a file here is that stage doing its job,"
 * not "you may write this." Returns the empty string when no other stage configures one, so a project
 * with no `extraScope` anywhere gets no heading and no dangling sentence.
 */
const otherStagesScopeNote = (stages: ProjectStages, currentStageName: string): string => {
    const others = stages.stages.filter(s => s.name !== currentStageName && s.extraScope.length > 0);
    if (others.length === 0) return '';

    return [
        '## Also in scope',
        '',
        'Not this card\'s own "Files in scope" above, but paths another stage may add under its own',
        'configured scope. A file here in the diff is that stage doing its job, not undeclared scope',
        'creep:',
        '',
        ...others.map(s => `- \`${s.name}\`: ${s.extraScope.map(g => `\`${g}\``).join(', ')}`),
    ].join('\n');
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
    ) {}

    async run(cardId: string, stageName: string): Promise<StageOutcome> {
        const stages = await this.stageConfigs.load();
        const stage = findStage(stages, stageName);

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

        const branch = this.worktrees.resolveBranch(head);

        // `base` means "start fresh if there is nothing to resume", not "always discard". A card
        // kicked back from review carries findings citing file:line on its own branch; rebuilding
        // from scratch throws away the work those findings are about, and any tests a later stage
        // already wrote. Since only a passing stage commits, a branch carrying work is by
        // construction the last state that satisfied an exit condition, so resuming is always safe.
        const resumable = stage.worktreeFrom === 'branch' || (await this.worktrees.hasWork(branch));
        let worktree = resumable ? await this.worktrees.resume(cardId, branch) : await this.worktrees.create(cardId, branch);

        // A resumed branch may be many merges behind. Left alone the stage implements against a tree
        // that no longer matches main, and neither its exit condition nor the review can distinguish
        // "this does not exist" from "this does not exist here".
        if (resumable) {
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
            payload: { branch, baseSha: worktree.baseSha, path: worktree.path },
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
        if (stage.worktree !== 'none' && this.settings && this.portAllocator) {
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

        // Before the agent sees the tree, not as its first task: a fresh worktree has no
        // node_modules, and card 0001 twice spent its whole run installing dependencies and
        // confirming the baseline built, then reported that as the work.
        //
        // Wrapped in `pnpmStoreLock` because this is an install: two of these racing pnpm's shared
        // store is what broke four of five cards started together in card 0081, and an agent's own
        // `pnpm install` through the bash tool takes the same lock, so either side waits for the
        // other rather than corrupting the store. The wait happens here, before `runAgent` below
        // ever starts the stage's `maxWallClockMs` clock — that clock opens inside the adapter's own
        // `generate()` call (`api.stage.agent.ts`/`cli.stage.agent.ts`), well after this returns — so
        // a stage queued behind another card's install is not charged for a queue it did not choose.
        if (stage.setupCommand) {
            const setupCommand = stage.setupCommand;
            // Captured alongside the log line `pnpmStoreLock` already emits, so a wait shows up in
            // the durable event trail too, not only in the log an operator has to be watching live —
            // the same reasoning `withCollateralCaveats` above applies to `scope.collateral`: a log
            // entry nobody reads before the review runs is not the same as recorded.
            let installWaitedMs: number | undefined;
            const failure = await pnpmStoreLock.run(
                `${cardId} ${stageName} setup`,
                message => this.logger.info(message),
                () => runConfiguredCommand(worktree.path, setupCommand, undefined, port),
                waitedMs => {
                    installWaitedMs = waitedMs;
                },
            );
            await this.events.append({
                project: this.config.project,
                cardId,
                stage: stageName,
                type: 'worktree.prepared',
                payload: {
                    command: setupCommand,
                    ok: !failure,
                    ...(failure ? { reason: failure.reason } : {}),
                    ...(installWaitedMs !== undefined ? { installWaitedMs } : {}),
                },
            });
            if (failure) {
                // Not retried: the race that used to produce this exact failure is gone now that the
                // install is serialized, so what reaches here is a genuine failure — a real lockfile
                // mismatch, a registry outage, a full disk — and retrying identical work against an
                // unpinned cause is exactly the waste `isPermanentFailure` exists to avoid elsewhere.
                // An unprepared worktree makes every later signal meaningless — the build would fail
                // for reasons that have nothing to do with the card.
                throw new Error(`worktree setup failed for ${cardId}: ${failure.reason}`);
            }
            this.logger.info(`worktree prepared with \`${setupCommand}\``);
        }

        const planPath = await this.materializePlan(card, pinnedSha, stages, stage);

        // Structural dependencies of a scoped file, one hop out — so the stage does not have to ask
        // for the file defining a type it is already using because something in scope imports it.
        const scoped = [...filesInScope(card), ...stage.extraScope];
        const collateral = await collateralPaths(worktree.path, scoped);

        // Every card's preserved patch, not just this one's (card 0161): a split card's plan
        // routinely names its parent's `last-failed-attempt.patch` as the single most useful
        // artifact around, and the stage running it has no way to know in advance which card that
        // will be — `boardCards`, already fetched above for `assertDispatchable`, is every card on
        // the board. Listed unconditionally, with no `stat` first: most cards have never failed, so
        // most of these paths do not exist, and an unconditional grant just lets that read fail with
        // an ordinary "no such file" — the same as any other in-scope path that happens to be
        // absent — rather than the scope refusal this card exists to remove.
        const preservedPatchPaths = boardCards.map(c => this.worktrees.failedAttemptPatchPath(c.frontmatter.id));

        const scope = new ScopeGuard({
            worktreeRoot: worktree.path,
            allow: scoped,
            alwaysAllowed: stages.alwaysAllowed,
            deny: stages.deny,
            collateral,
            // The plan and every card's preserved patch live outside the worktree so neither can be
            // committed to the card's branch. Without this both are also unreadable, and the agent
            // either infers its own contract or is refused the one artifact its plan told it to read.
            readableExtras: [planPath, ...preservedPatchPaths],
        });

        await this.events.append({
            project: this.config.project,
            cardId,
            stage: stageName,
            type: 'stage.dispatched',
            payload: { provider: stage.provider, model: stage.model, planPath, scope: scoped },
        });

        try {
            const ran = await this.runAgent({ card, stage, worktree, scope, planPath, stages, port });

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
            const outcome = withCollateralCaveats(ran, collateralHits);

            // Only a passing stage commits. A failed stage leaves its work in the worktree for
            // inspection, and the next attempt starts from the base rather than building on a tree
            // that did not satisfy its exit condition.
            if (outcome.passed) {
                const sha = await this.worktrees.commit(worktree, `${cardId}: ${stageName}\n\n${describe(outcome.result)}`);
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
                    failures: outcome.failures,
                    changedPaths: outcome.changedPaths,
                    grants: outcome.scopeGrants,
                    usage: outcome.usage,
                    // The result itself, not just its shape. A review's findings *are* the output of
                    // the stage; recording only that it passed throws away the thing it produced.
                    result: outcome.result ?? null,
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

            if (stage.mode !== 'agent') {
                return outcome;
            }

            // Outside the try below, and in its own: the stage's outcome is already recorded, and a
            // transition that fails to write must not be reported as the stage having failed. Sharing
            // the catch would append a `stage.failed` event after a `stage.passed` one for the same
            // run, leaving the card's history contradicting itself about what the stage did.
            let transitionedTo: string | undefined;
            let needsHuman = false;
            try {
                const transition = await this.writeTransition(cardId, stageName, stage, head, card, outcome);
                transitionedTo = transition.target;
                needsHuman = transition.needsHuman;
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
            return { ...outcome, transitionedTo, needsHuman };
        } catch (err) {
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
    ): Promise<{ target: string; needsHuman: boolean }> {
        // `retries` and `needsHuman` come from `head`, not `card`: both are runner state, and `card`
        // is frozen at approval — a retry count read from it would forget every attempt made since,
        // and a flag read from it would look unset even after the card was flagged post-approval.
        let decision: KickbackDecision = shouldAdvance(outcome.passed, outcome.result)
            ? { target: stage.onPass, retries: head.frontmatter.retries }
            : kickback(stage, head.frontmatter.retries, Boolean(outcome.unjudged), Boolean(outcome.resultDropped));

        // Card 0200: a card whose ticket closed externally while this stage was running halts here
        // instead of advancing or kicking back further, once this one stage — already bounded by its
        // own budget — finishes. `InboundCardWriter` is what set the flag going in; this is the one
        // place that flag turns into "stop". Only overrides when the ordinary decision did not
        // already flag one: an exhausted kickback's own reason must not be replaced by this one.
        if (head.frontmatter.sourceClosed && !decision.needsHuman) {
            decision = { target: stageName, retries: decision.retries, needsHuman: { reason: 'source-closed' } };
        }

        const findings = findingsFrom(outcome.result);
        const needsHuman = decision.needsHuman;

        const writtenVersionId = await this.board.writeWithEvent(
            cardId,
            `${cardId}: ${stageName} -> ${decision.target}`,
            current => ({
                ...current,
                frontmatter: {
                    ...current.frontmatter,
                    stage: decision.target,
                    retries: decision.retries,
                    ...(needsHuman ? { needsHuman: true, needsHumanReason: needsHuman.reason } : {}),
                },
                body: findings ? withFindings(current.body, findings) : current.body,
            }),
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
                },
            },
        );

        // The write above just rewrote the plan contract, not just runner state: a non-empty
        // `findings` means `withFindings` folded a `## Review findings` section into the body of
        // the version `writtenVersionId` now names. A pinned card's `planVersionId` otherwise holds
        // still against everything that lands on the board — that is the whole point of pinning
        // (see the "Two reads" comment at the top of `run`, above) — and a human editing the card
        // body must keep not moving it. But the runner rewriting its
        // own contract is the one case where the pin legitimately advances: left where it was, the
        // pin would keep pointing at a version that predates the very findings this stage was kicked
        // back to fix, which is card 0091's bug — three implementing passes reading a plan with no
        // findings section because the pin still named the version from before the kickback wrote
        // them. Gated on `head.frontmatter.planVersionId`, not `current`'s: a card with no pin coming
        // in gets none out (117 of 128 cards read live `head` today and must keep doing so), and the
        // inner check against `current.frontmatter.planVersionId` mirrors the branch-recording guard
        // above — `write`'s re-read inside its own transaction is what actually guards the race, this
        // is only the common-case short-circuit.
        if (findings && findings.length > 0 && head.frontmatter.planVersionId) {
            await this.board.write(cardId, `${cardId}: advance plan pin past ${stageName} findings`, current =>
                current.frontmatter.planVersionId
                    ? { ...current, frontmatter: { ...current.frontmatter, planVersionId: writtenVersionId } }
                    : current,
            );
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

        return { target: decision.target, needsHuman: needsHuman !== undefined };
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
        // A hard block: file-based coordination cannot carry an in-flight API contract between two
        // running agents (PROJECT.md, dependency blocking).
        const outstanding = unsatisfiedDependencies(head, cards);
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
     * Write the plan where the agent can read it — outside the worktree.
     *
     * The board is a sibling repo, so the plan is not in the tree the agent is editing. Materializing
     * it outside means it can never be accidentally committed to the card's branch.
     *
     * Appends `ownScopeNote` and `otherStagesScopeNote` after the card's own body — the one place
     * every stage's agent, review included, actually reads (card 0139). `stages` is the same config
     * `run` already loaded for this dispatch, not a second load.
     */
    private async materializePlan(card: Card, sha: string | undefined, stages: ProjectStages, stage: StageConfig): Promise<string> {
        const dir = join(this.config.runRoot, 'cards', card.frontmatter.id);
        await mkdir(dir, { recursive: true });
        const path = join(dir, 'plan.md');
        const notes = [ownScopeNote(stage), otherStagesScopeNote(stages, stage.name)].filter(note => note.length > 0);
        const material = notes.length > 0 ? `${serializeCard(card).trimEnd()}\n\n${notes.join('\n\n')}\n` : serializeCard(card);
        await writeFile(path, material, 'utf8');
        this.logger.info(`plan for ${card.frontmatter.id} materialized at ${path}${sha ? ` (${sha.slice(0, 8)})` : ''}`);
        return path;
    }

    private async runAgent(input: {
        card: Card;
        stage: StageConfig;
        worktree: Awaited<ReturnType<WorktreeManager['create']>>;
        scope: ScopeGuard;
        planPath: string;
        stages: ProjectStages;
        /** `run`'s allocated dev server port for this worktree (card 0027), or `undefined` when no range is configured. */
        port?: number;
    }): Promise<StageOutcome> {
        const { card, stage, worktree, scope, planPath, stages, port } = input;

        const context: ToolContext = {
            project: this.config.project,
            cardId: card.frontmatter.id,
            stage: stage.name,
            worktreeRoot: worktree.path,
            scope,
            commands: new CommandAllowlist(stage.allowedCommands),
            // The stage's own value wins when it sets one; otherwise the project-wide default applies,
            // exactly as it did before this field existed (`stage.config.ts`).
            scopeViolationPolicy: stage.scopeViolation ?? stages.scopeViolation,
            port,
            events: this.events,
            logger: this.logger,
        };

        const resultSchema = this.resultSchemas.get(stage.verifier ?? stage.name);
        if (!resultSchema) {
            throw new Error(
                `stage "${stage.name}" names verifier "${stage.verifier ?? stage.name}", which has no registered result schema (have: ${[...this.resultSchemas.keys()].join(', ')})`,
            );
        }

        const adapter = this.agents.get(stage.adapter);
        if (!adapter) {
            throw new Error(
                `stage "${stage.name}" names adapter "${stage.adapter}", which is not registered (have: ${[...this.agents.keys()].join(', ')})`,
            );
        }

        const run = await adapter.run({ stage, context, planPath, title: card.frontmatter.title, resultSchema, baseSha: worktree.baseSha });

        const verifier = this.verifiers.get(stage.verifier ?? stage.name);
        if (!verifier) {
            throw new Error(
                `stage "${stage.name}" names verifier "${stage.verifier ?? stage.name}", which is not registered (have: ${[...this.verifiers.keys()].join(', ')})`,
            );
        }
        const reported = run.result;
        const verification = await verifier.verify({ worktree, scope, stage, cardId: card.frontmatter.id, result: reported });
        const failures = [...verification.failures];

        // A result that never parsed against the stage's own schema carries no judgment about the
        // code — there is nothing coherent for a verifier to have judged. Checked here, against the
        // same schema the report tool itself enforces, so every stage gets this for free instead of
        // each verifier re-parsing its own schema just to tell the dispatcher what it already knows
        // for its own reasons (`ReviewVerifier` does this today, to return early on a hallucinated
        // result before checking findings' provenance). Guarded on `safeParse` actually being a
        // function: every stage registered through `StagesModule` gets a real Zod schema here, but a
        // test double standing in for one is not this check's business to reject.
        const schemaInvalid =
            reported !== undefined && typeof resultSchema.safeParse === 'function' && !resultSchema.safeParse(reported).success;

        // A stage that never called the report tool never said it was finished. Whatever is in the
        // tree is where it happened to stop, not what it set out to produce. A stage that *did* call
        // it is a different sentence: the work is done and the runner lost the paperwork, not the
        // agent's fault, which is exactly what `run.resultDropped` distinguishes (`stage.agent.ts`).
        if (reported === undefined) {
            failures.unshift(
                run.resultDropped
                    ? `the stage called ${REPORT_TOOL} and the result did not arrive, so the runner never saw it`
                    : `the stage ended without calling ${REPORT_TOOL}, so it never reported finishing`,
            );
        }

        // A loop that ran out of steps did not finish; it stopped. Card 0002 exhausted its 60 steps
        // a third of the way through its plan, emitted a placeholder result, and passed — because
        // the diff was non-empty, in scope, and built. Truncation is knowable, so it is checked.
        //
        // Only when no more specific cause is known: a wall-clock or token-budget cutoff can land
        // with `truncated: true` well before the step count is exhausted, and naming the step cap
        // there would be false — `run.budgetFailure`, pushed below, already names the real cause.
        if (run.truncated && !run.budgetFailure && !run.engineFailure) {
            failures.unshift(
                `the stage used all ${stage.maxSteps} of its steps and was cut off mid-run — its work is partial whatever the diff shows`,
            );
        }

        if (run.budgetFailure) {
            failures.unshift(run.budgetFailure);
        }

        // Ahead of everything else: when the engine stopped responding, nothing downstream of it —
        // an empty diff, a missing result, a build that never ran — describes a decision the stage
        // made. Leading with the cause stops the operator reading the symptoms as the problem.
        if (run.engineFailure) {
            failures.unshift(run.engineFailure);
        }

        // None of the checks above is a verdict on the code: a truncated run, a budget or engine
        // cutoff, a missing report and an unparseable result are all the stage failing to finish, not
        // a judgment of what it produced. Left `false` when a verifier's own substantive checks are
        // what failed — a bad citation, an empty diff, a verdict that contradicts its severities —
        // since those are exactly the judgments `writeTransition`/`kickback` should route past.
        const unjudged =
            failures.length > 0 &&
            (reported === undefined || schemaInvalid || run.truncated || Boolean(run.budgetFailure) || Boolean(run.engineFailure));

        return {
            passed: failures.length === 0,
            failures,
            changedPaths: verification.changedPaths,
            scopeGrants: scope.grants(),
            result: reported,
            usage: run.usage,
            unjudged,
            resultDropped: run.resultDropped,
            engineStopReason: run.engineStopReason,
        };
    }
}
