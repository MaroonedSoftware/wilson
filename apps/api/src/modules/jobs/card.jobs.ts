import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';

/** The job states that mean a card is still being carried. Anything else has settled. */
const LIVE_STATES = new Set(['created', 'retry', 'active']);

/**
 * Which job, if any, is carrying a card.
 *
 * The runner had no authoritative answer to that, and three separate problems came out of the one
 * gap: `card start` would enqueue a card that was already running, a poller cannot be built without
 * it, and a stage abandoned by a dead worker looked exactly like one still working.
 *
 * The stored row is a **claim, not an answer.** It says which job was last enqueued for a card; the
 * broker's view of that job decides whether the card is actually in flight. A row whose job has
 * completed, failed or been cancelled is deleted on read — which is the reconciler, and why it needs
 * no separate sweep: a card stops claiming to be in flight the first time anything asks.
 *
 * Operational state, deliberately not board state. Nothing here reaches `Card` or its frontmatter.
 */
@Injectable()
export class CardJobs {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
        private readonly broker: JobBroker,
    ) {}

    /** Claim the card for a job. One job per card, so a second enqueue replaces the first. */
    async record(cardId: string, jobId: string): Promise<void> {
        await this.db
            .insertInto('runner.cardJobs')
            .values({ project: this.config.project, cardId, jobId })
            .onConflict(conflict => conflict.columns(['project', 'cardId']).doUpdateSet({ jobId }))
            .execute();
    }

    /** Release the card. Safe to call when it holds no claim. */
    async clear(cardId: string): Promise<void> {
        await this.db.deleteFrom('runner.cardJobs').where('project', '=', this.config.project).where('cardId', '=', cardId).execute();
    }

    /**
     * The id of the job carrying this card, or undefined if nothing is.
     *
     * Asks the broker rather than trusting the row. A job the broker cannot find at all counts as
     * settled too: it was deleted or the queue was reset, and either way nothing is running.
     */
    async inFlight(cardId: string): Promise<string | undefined> {
        const row = await this.db
            .selectFrom('runner.cardJobs')
            .select('jobId')
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .executeTakeFirst();
        if (!row) return undefined;

        const job = await this.broker.getJob('card.stage', row.jobId);
        if (job && LIVE_STATES.has(job.state)) return row.jobId;

        await this.clear(cardId);
        return undefined;
    }
}
