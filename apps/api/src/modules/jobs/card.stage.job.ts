import { Injectable } from 'injectkit';
import { Job, JobBroker } from '@maroonedsoftware/jobbroker';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { EventLog } from '#modules/events/event.log.js';
import { isPermanentFailure } from '#modules/stages/permanent.failure.js';
import { loadStages } from '#modules/stages/stage.config.js';
import { NotDispatchableError, StageDispatcher } from '#modules/stages/stage.dispatcher.js';
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
 */
export async function poisonCard(
    deps: { boardRepo: BoardRepository; events: EventLog },
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

    await deps.boardRepo.write(cardId, `Poison ${cardId}: ${reason.slice(0, 60)}`, card => ({
        ...card,
        frontmatter: { ...card.frontmatter, stage: 'poisoned' },
    }));

    await deps.events.append({
        project,
        cardId,
        stage: stageName,
        type: 'transition.written',
        payload: { from: stageName, to: 'poisoned', by: 'runner', reason },
    });
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
     * Stop a card whose failure retrying cannot fix. See {@link poisonCard} for the shared write.
     *
     * The job returns normally afterwards so the queue does not retry it either — the whole point is
     * that the next attempt fails identically.
     */
    private async poison(cardId: string, stageName: string, error: unknown): Promise<void> {
        const reason = error instanceof Error ? error.message : String(error);
        await poisonCard({ boardRepo: this.boardRepo, events: this.events }, { project: this.board.project, cardId, stageName, reason });
    }
}
