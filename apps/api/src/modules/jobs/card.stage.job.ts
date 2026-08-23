import { Injectable } from 'injectkit';
import { Job, JobBroker } from '@maroonedsoftware/jobbroker';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { EventLog } from '#modules/events/event.log.js';
import { isPermanentFailure } from '#modules/stages/permanent.failure.js';
import { loadStages } from '#modules/stages/stage.config.js';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { decideChain } from './chain.decision.js';

export interface CardStagePayload {
    cardId: string;
    stageName: string;
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
    ) {
        super();
    }

    async run({ cardId, stageName }: CardStagePayload): Promise<void> {
        let outcome;
        try {
            outcome = await this.dispatcher.run(cardId, stageName);
        } catch (error) {
            if (!isPermanentFailure(error)) {
                // Transient: let it throw so the queue retries under its policy.
                throw error;
            }
            await this.poison(cardId, stageName, error);
            return;
        }

        // Unset means the stage just run was a `manual` gate the dispatcher left alone — nothing
        // for the chain to do until a human moves the card.
        if (!outcome.transitionedTo) {
            return;
        }

        const stages = await loadStages(this.board.boardRoot);
        const decision = decideChain(outcome.transitionedTo, stages);

        if (decision.continue) {
            await this.broker.send('card.stage', { cardId, stageName: outcome.transitionedTo });
            return;
        }

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
     * Stop a card whose failure retrying cannot fix.
     *
     * `poisoned` is a terminal state and deliberately not a kickback: the card's retry budget is for
     * work that came back wrong, and spending it on an exhausted balance or a missing credential
     * both wastes the budget and misreports the cause. The job returns normally afterwards so the
     * queue does not retry it either — the whole point is that the next attempt fails identically.
     */
    private async poison(cardId: string, stageName: string, error: unknown): Promise<void> {
        const reason = error instanceof Error ? error.message : String(error);

        await this.events.append({
            project: this.board.project,
            cardId,
            stage: stageName,
            type: 'stage.poisoned',
            payload: { reason },
        });

        await this.boardRepo.write(cardId, `Poison ${cardId}: ${reason.slice(0, 60)}`, card => ({
            ...card,
            frontmatter: { ...card.frontmatter, stage: 'poisoned' },
        }));

        await this.events.append({
            project: this.board.project,
            cardId,
            stage: stageName,
            type: 'transition.written',
            payload: { from: stageName, to: 'poisoned', by: 'runner', reason },
        });
    }
}
