import { Injectable } from 'injectkit';
import { Job, JobContext } from '@maroonedsoftware/jobbroker';
import { PgBoss } from 'pg-boss';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { EventLog } from '#modules/events/event.log.js';
import { isTerminal } from '#modules/stages/terminal.js';
import { CardJobs } from './card.jobs.js';
import { poisonCard, type CardStagePayload } from './card.stage.job.js';

/** The shape pg-boss serializes a job's final failure into, and stores as that job's own `output`. */
interface JobFailureOutput {
    name?: string;
    message?: string;
    stack?: string;
}

/**
 * Handles a `card.stage` job that exhausted pg-boss's retries and landed in `card.stage.dead`.
 *
 * `card.stage.dead` was write-only until this job: pg-boss moved the corpse there and nothing ever
 * read it, so `card list`, `card next`, `card show` and `wilson doctor` kept reporting the card as
 * though a stage were still running. Subscribing here — rather than adding a join against
 * `pgboss.job` to every one of those surfaces — makes them correct for free.
 *
 * A dead-lettered row is a claim that a job died, not proof the card is still stuck: a human may
 * already have noticed the stall and moved the card by hand while the corpse sat in the queue (all
 * of today's dead rows are exactly that). So this only acts when the card is still sitting in the
 * stage the dead job names; otherwise it just records that the row was already resolved.
 */
@Injectable()
export class CardStageDeadJob extends Job<CardStagePayload> {
    constructor(
        private readonly pgboss: PgBoss,
        private readonly context: JobContext,
        private readonly board: BoardConfig,
        private readonly boardRepo: BoardRepository,
        private readonly events: EventLog,
        private readonly cardJobs: CardJobs,
    ) {
        super();
    }

    async run({ cardId, stageName }: CardStagePayload): Promise<void> {
        const card = await this.boardRepo.read(cardId);

        if (card.frontmatter.stage !== stageName || isTerminal(card.frontmatter.stage)) {
            // The card moved on (or was already recovered by hand) before this row was ever read.
            // Recorded so the death is not silently dropped, but nothing else changes: transitioning
            // on sight here would poison a card that a human already finished dealing with.
            await this.events.append({
                project: this.board.project,
                cardId,
                stage: stageName,
                type: 'stage.dead',
                payload: { jobId: this.context.id, alreadyResolved: true, currentStage: card.frontmatter.stage },
            });
            return;
        }

        // pg-boss carries the failed job's own output (name/message/stack of its last error) forward
        // onto the dead-letter row it inserts for it, so this job's own record — not the original
        // job's, which is gone — already has everything the final attempt reported.
        const deadJob = await this.pgboss.getJobById<CardStagePayload>(this.context.name, this.context.id);
        const output = deadJob?.output as JobFailureOutput | undefined;
        const reason = output?.message ?? 'card.stage exhausted its retries with no recorded error';

        await this.events.append({
            project: this.board.project,
            cardId,
            stage: stageName,
            type: 'stage.dead',
            payload: { jobId: this.context.id, reason },
        });

        await poisonCard({ boardRepo: this.boardRepo, events: this.events }, { project: this.board.project, cardId, stageName, reason });

        await this.cardJobs.clear(cardId);
    }
}
