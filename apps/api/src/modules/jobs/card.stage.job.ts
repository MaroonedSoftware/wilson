import { Injectable } from 'injectkit';
import { Job, JobBroker } from '@maroonedsoftware/jobbroker';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { git } from '#modules/board/git.js';
import { EventLog } from '#modules/events/event.log.js';
import { commitsBehind } from '#modules/health/health.service.js';
import { Notifier } from '#modules/notify/notifier.js';
import { isPermanentFailure } from '#modules/stages/permanent.failure.js';
import { loadStages } from '#modules/stages/stage.config.js';
import { NotDispatchableError, StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { isTerminal } from '#modules/stages/terminal.js';
import { buildHead } from '#src/server/build.info.js';
import { decideChain } from './chain.decision.js';
import { CardJobs } from './card.jobs.js';

export interface CardStagePayload {
    cardId: string;
    stageName: string;
}

/**
 * Stop a card whose failure retrying cannot fix, wherever that failure was noticed.
 *
 * `poisoned` is a terminal state and deliberately not a kickback: the card's retry budget is for
 * work that came back wrong, and spending it on an exhausted balance or a missing credential both
 * wastes the budget and misreports the cause.
 *
 * Shared: `CardStageJob` calls this the moment a stage's own failure is classified permanent, and
 * `CardStageDeadJob` calls it once a `card.stage` job has exhausted pg-boss's retries instead —
 * same destination, same board write, same event shape, regardless of which noticed the failure.
 *
 * `deps.board` is optional only so a caller with no `BoardConfig` in hand still compiles; every
 * real caller has one already injected, and without it a poisoning cannot notify (card 0050) since
 * that is where `notifyWebhookUrl`/`notifyBaseUrl` live.
 */
export async function poisonCard(
    deps: { boardRepo: BoardRepository; events: EventLog; board?: BoardConfig },
    args: { project: string; cardId: string; stageName: string; reason: string },
): Promise<void> {
    const { project, cardId, stageName, reason } = args;

    await deps.events.append({
        project,
        cardId,
        stage: stageName,
        type: 'stage.poisoned',
        payload: { reason },
    });

    // Captured from the fresh row `write` reads inside its own transaction, rather than a separate
    // read here: a notification needs something to call the card, and the id alone is not it. Also
    // doubles as the redelivery guard below — a card already poisoned before this write started
    // means some earlier attempt already reported this poisoning.
    let title = cardId;
    let alreadyPoisoned = false;
    await deps.boardRepo.write(cardId, `Poison ${cardId}: ${reason.slice(0, 60)}`, card => {
        title = card.frontmatter.title;
        alreadyPoisoned = card.frontmatter.stage === 'poisoned';
        return {
            ...card,
            frontmatter: { ...card.frontmatter, stage: 'poisoned' },
        };
    });

    await deps.events.append({
        project,
        cardId,
        stage: stageName,
        type: 'transition.written',
        payload: { from: stageName, to: 'poisoned', by: 'runner', reason },
    });

    // Do not send twice for one event: a retried or redelivered job that lands here after the card
    // was already poisoned by an earlier attempt has nothing new to report.
    if (deps.board && !alreadyPoisoned) {
        await new Notifier(deps.board.notifyWebhookUrl, deps.board.notifyBaseUrl).notify({
            project,
            cardId,
            title,
            stage: stageName,
            moment: 'poisoned',
            reason,
        });
    }
}

/**
 * Cards this process is mid-run on right now.
 *
 * `runner.card_jobs` (via `CardJobs`) is the durable claim — which job, if any, is carrying a card,
 * queryable by any process at any time. It does not say which card THIS worker's `card.stage`
 * handler is inside `run()` for at this instant, and that is exactly what a bounded shutdown needs
 * to name: not every claimed card on the board, just the one this process would be abandoning.
 * `CardStageJob.run` adds a card on entry and removes it once the handler settles — normally,
 * permanently-failed, or thrown — so a card still here past a deadline is one whose handler never
 * returned.
 */
@Injectable()
export class RunningCards {
    private readonly cardIds = new Set<string>();

    add(cardId: string): void {
        this.cardIds.add(cardId);
    }

    delete(cardId: string): void {
        this.cardIds.delete(cardId);
    }

    /** Cards this process was mid-run on at the moment this was called. */
    snapshot(): string[] {
        return [...this.cardIds];
    }
}

/**
 * Runs one stage for one card, then decides whether the chain keeps going.
 *
 * `StageDispatcher.run` only ever reports where a card landed (`transitionedTo`), forward on a pass
 * or backward on a kickback, and leaves it unset for a `manual` stage it deliberately does not
 * touch. Turning "landed here" into "keep going" or "stop" is this job's decision, kept out of the
 * dispatcher so it stays queue-agnostic — `wilson card run` calls the same dispatcher without ever
 * enqueuing anything.
 */
@Injectable()
export class CardStageJob extends Job<CardStagePayload> {
    constructor(
        private readonly dispatcher: StageDispatcher,
        private readonly broker: JobBroker,
        private readonly board: BoardConfig,
        private readonly boardRepo: BoardRepository,
        private readonly events: EventLog,
        private readonly cardJobs: CardJobs,
        // Defaulted, not just typed optional: DI (jobs.module.ts) always supplies the shared
        // singleton, so this only matters for a test constructing a job by hand with the six
        // dependencies it cares about — it still gets a valid (if unshared) tracker rather than a
        // `this.running.add is not a function` crash on the first `run()` call.
        private readonly running: RunningCards = new RunningCards(),
    ) {
        super();
    }

    async run({ cardId, stageName }: CardStagePayload): Promise<void> {
        this.running.add(cardId);
        try {
            await this.runStage(cardId, stageName);
        } finally {
            this.running.delete(cardId);
        }
    }

    private async runStage(cardId: string, stageName: string): Promise<void> {
        await this.checkDaemonCurrent(cardId, stageName);

        let outcome;
        try {
            outcome = await this.dispatcher.run(cardId, stageName);
        } catch (error) {
            // Checked before isPermanentFailure, which stays message-based for provider errors:
            // assertDispatchable's refusals are typed, so they are routed on their discriminant
            // rather than falling through to pattern matching.
            if (error instanceof NotDispatchableError) {
                if (error.reason.kind === 'unsatisfied-dependency') {
                    await this.defer(cardId, stageName, error.reason.outstanding, error.message);
                } else if (error.reason.kind === 'wrong-stage' && isTerminal(error.reason.actualStage)) {
                    await this.stale(cardId, stageName, error.reason.actualStage);
                } else {
                    await this.poison(cardId, stageName, error);
                }
                await this.cardJobs.clear(cardId);
                return;
            }
            if (!isPermanentFailure(error)) {
                // Transient: let it throw so the queue retries under its policy.
                throw error;
            }
            await this.poison(cardId, stageName, error);
            await this.cardJobs.clear(cardId);
            return;
        }

        // Unset means the stage just run was a `manual` gate the dispatcher left alone — nothing
        // for the chain to do until a human moves the card.
        if (!outcome.transitionedTo) {
            await this.cardJobs.clear(cardId);
            return;
        }

        const stages = await loadStages(this.board.boardRoot);
        const decision = decideChain(outcome.transitionedTo, stages, { needsHuman: outcome.needsHuman });

        if (decision.continue) {
            // Hand the claim straight to the next job rather than clearing and re-recording: the card
            // is continuously in flight across a chain, and a gap between the two is a window a
            // poller would enqueue into.
            const jobId = await this.broker.send('card.stage', { cardId, stageName: outcome.transitionedTo });
            await this.cardJobs.record(cardId, jobId);
            return;
        }

        await this.cardJobs.clear(cardId);

        // Recorded rather than silently dropped: an operator watching the card's history needs to
        // know the chain stopped here, and why, without having to reconstruct it from stage config.
        await this.events.append({
            project: this.board.project,
            cardId,
            stage: stageName,
            type: 'chain.stopped',
            payload: { target: outcome.transitionedTo, reason: decision.reason },
        });

        // A manual gate reached normally is one of the three moments PROJECT.md's Notification
        // section names (card 0050); the other two (needsHuman, poisoned) are notified where they
        // are written, in StageDispatcher and poisonCard. `needsHuman` is excluded here because it
        // is the other, already-notified reason the chain can stop on a perfectly ordinary agent
        // stage — decideChain checks it first, before it ever looks at the target's mode.
        if (!outcome.needsHuman) {
            const landedOn = stages.stages.find(s => s.name === outcome.transitionedTo);
            if (landedOn?.mode === 'manual') {
                await this.notifyManualGate(cardId, outcome.transitionedTo);
            }
        }
    }

    /**
     * Tell a person the card is waiting on them at a manual gate — one webhook call, off entirely
     * when `NOTIFY_WEBHOOK_URL` is unset (card 0050). The card is re-read for its title only when a
     * webhook is actually configured, so this costs nothing on the common, notification-off path.
     */
    private async notifyManualGate(cardId: string, stage: string): Promise<void> {
        if (!this.board.notifyWebhookUrl) return;

        const card = await this.boardRepo.read(cardId).catch(() => undefined);
        await new Notifier(this.board.notifyWebhookUrl, this.board.notifyBaseUrl).notify({
            project: this.board.project,
            cardId,
            title: card?.frontmatter.title ?? cardId,
            stage,
            moment: 'manual',
        });
    }

    /**
     * Leave a dependency-blocked card exactly where it is.
     *
     * "Not now", not "never" (unlike `poison`): the outstanding cards may simply not have merged
     * yet, and poisoning here is precisely the false positive `permanent.failure.ts` warns against —
     * a card that would have recovered gets stranded. So this writes nothing to the board: the
     * card's stage and retries are untouched, and the same dispatch that failed today succeeds
     * unchanged once something enqueues it again. Recorded so an operator can see why the chain did
     * not move without reconstructing it from the board.
     */
    private async defer(cardId: string, stageName: string, outstanding: string[], reason: string): Promise<void> {
        await this.events.append({
            project: this.board.project,
            cardId,
            stage: stageName,
            type: 'dispatch.deferred',
            payload: { outstanding, reason },
        });
    }

    /**
     * A job arrived for a card that has already finished — not a bug, once the card's current stage
     * is terminal. A card reaches `merged` (or `dropped`/`poisoned`) while a job for its last stage
     * is still queued, `wilson card move` reclaims the worktree on the human's transition, and this
     * job then dispatches into a card that is done. Poisoning it here would be card 0066/0082's bug:
     * undoing a human's completed merge because a stale job showed up after the fact.
     *
     * So this changes nothing about the card — no transition, no worktree touch — and only records
     * that the arrival happened, the same reasoning card 0051 already applies to a dead-lettered job
     * landing on a card a human resolved by hand.
     */
    private async stale(cardId: string, wantedStage: string, actualStage: string): Promise<void> {
        await this.events.append({
            project: this.board.project,
            cardId,
            stage: wantedStage,
            type: 'stage.stale',
            payload: { wantedStage, actualStage },
        });
    }

    /**
     * Stop a card whose failure retrying cannot fix. See {@link poisonCard} for the shared write.
     *
     * The job returns normally afterwards so the queue does not retry it either — the whole point is
     * that the next attempt fails identically.
     */
    private async poison(cardId: string, stageName: string, error: unknown): Promise<void> {
        const reason = error instanceof Error ? error.message : String(error);
        await poisonCard(
            { boardRepo: this.boardRepo, events: this.events, board: this.board },
            { project: this.board.project, cardId, stageName, reason },
        );
    }

    /**
     * Card 0100. Nothing used to check that this process was running current code before it
     * dispatched a card — `daemonCurrent` (packages/cli/src/checks/daemon.current.ts) only ever ran
     * when a human happened to run `wilson doctor`, and a merge (the moment staleness is created) is
     * a normal part of running the board, not an occasional event a manual check will reliably catch.
     * This runs on every dispatch instead, which is the moment it actually matters.
     *
     * `codeRoot`'s current HEAD is "the commit the card's worktree is about to be cut from": every
     * path through `WorktreeManager` — a fresh `create()`, or a `resume()` immediately followed by
     * `rebaseOntoHead()` — ends with the worktree's `baseSha` equal to that HEAD, so reading it here,
     * before `StageDispatcher.run` ever cuts the tree, needs no change to `StageDispatcher` and no
     * second mechanism for reading the daemon's own commit (`HealthService`'s `buildHead`/
     * `commitsBehind`, card 0079, already answer that).
     *
     * Deliberately never blocks: a daemon one commit behind is the steady state of a running board,
     * not an exceptional one, so this only records what it found and lets the stage dispatch anyway.
     */
    private async checkDaemonCurrent(cardId: string, stageName: string): Promise<void> {
        if (buildHead() === 'unknown') return;

        const baseSha = await git(this.board.codeRoot, ['rev-parse', 'HEAD'])
            .then(result => result.stdout.trim())
            .catch(() => undefined);
        if (!baseSha) return;

        const behindBy = await commitsBehind(this.board.codeRoot, baseSha);
        if (behindBy <= 0) return;

        await this.events.append({
            project: this.board.project,
            cardId,
            stage: stageName,
            type: 'daemon.stale',
            payload: { daemonCommit: buildHead(), baseCommit: baseSha, behindBy },
        });
    }
}
