import { Injectable } from 'injectkit';
import { Kysely, sql } from 'kysely';
import type { DateTime } from 'luxon';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';
import type { CardStagePayload } from './card.stage.job.js';

/** The job states that mean a card is still being carried. Anything else has settled. */
const LIVE_STATES = new Set(['created', 'retry', 'active']);

/**
 * An `active` `card.stage` job as pg-boss's own `pgboss.job` table records it — everything card
 * 0272's boot sweep needs to fail it and explain why: `jobId` for `PgBoss.fail`, `payload` for the
 * card and (maybe) project it belongs to, `startedOn` for the card's timeline. See
 * {@link CardJobs.activeCardStageJobs}.
 */
export interface ActiveCardStageJob {
    jobId: string;
    payload: CardStagePayload;
    startedOn: DateTime | undefined;
}

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

    /** The job id this card last claimed, or undefined if it holds no claim at all. */
    private async claimedJobId(cardId: string): Promise<string | undefined> {
        const row = await this.db
            .selectFrom('runner.cardJobs')
            .select('jobId')
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .executeTakeFirst();
        return row?.jobId;
    }

    /**
     * The id of the job carrying this card, or undefined if nothing is.
     *
     * Asks the broker rather than trusting the row. A job the broker cannot find at all counts as
     * settled too: it was deleted or the queue was reset, and either way nothing is running.
     *
     * For the poller (`poller.ts`), on a live system where going through the broker is correct.
     * Shutdown has a different problem — see `confirmInFlightAfterStop` — and must not use this.
     */
    async inFlight(cardId: string): Promise<string | undefined> {
        const jobId = await this.claimedJobId(cardId);
        if (!jobId) return undefined;

        const job = await this.broker.getJob('card.stage', jobId);
        if (job && LIVE_STATES.has(job.state)) return jobId;

        await this.clear(cardId);
        return undefined;
    }

    /**
     * Same question as `inFlight` — is a job still carrying this card — asked the one way that
     * still works once pg-boss's own connection may already be closed: `stopCardStageJobs`
     * (`jobs.module.ts`) calls this only after `runner.stop()` has returned, precisely the moment
     * `inFlight`'s `broker.getJob` starts throwing (`Manager.assertDb`, "Database connection is not
     * opened") because stopping pg-boss closes the connection its manager reads through.
     *
     * `this.db` is the application's own Kysely pool, a connection independent of pg-boss's and
     * still open at this point (`Data` tears its pool down after `Jobs` — module order in
     * `modules.ts`), and pg-boss's job rows are ordinary rows in the `pgboss` schema, so this reads
     * `pgboss.job` directly instead of going through the stopped manager.
     *
     * That is a direct coupling to pg-boss's internal storage layout — its schema name and its
     * `job.state` column's values — rather than its public API, and would silently start reading
     * nothing (or the wrong thing) if a future pg-boss version renamed either. It is deliberate: the
     * alternative is not asking the question at all, which is the bug this exists to fix. Confirmed
     * against pg-boss 12.27.0's `plans.js` (`createTableJob`, `${schema}.job`, default schema
     * `pgboss`) and the same `job_state` values `LIVE_STATES` already tracks for `inFlight`.
     *
     * Left to throw rather than caught here: a query that fails (the row's job id vanished from a
     * schema that also doesn't exist, a dropped connection of the app's own) is not "the card
     * settled" and must not be reported as if it were. `stopCardStageJobs` is what decides what an
     * unanswerable question means for the report.
     */
    async confirmInFlightAfterStop(cardId: string): Promise<string | undefined> {
        const jobId = await this.claimedJobId(cardId);
        if (!jobId) return undefined;

        const { rows } = await sql<{ state: string }>`select state from pgboss.job where id = ${jobId}`.execute(this.db);
        const state = rows[0]?.state;
        if (state && LIVE_STATES.has(state)) return jobId;

        await this.clear(cardId);
        return undefined;
    }

    /**
     * Every `card.stage` job pg-boss currently shows as `active`, across every registered project —
     * `pgboss.job` carries no project column of its own; a job's project (if any) lives inside its
     * own `data` payload instead (`CardStagePayload.project`). Read the same direct-SQL way
     * `confirmInFlightAfterStop` reads `pgboss.job` (see that method's own doc comment for why this
     * is sound), because this runs even earlier: `BoundedCardStageJobRunner.start()`'s boot sweep
     * (card 0272), before pg-boss's own worker exists to ask through the broker.
     *
     * `created`/`retry` jobs are deliberately left out of the `where` — only `active` means a job
     * claims to be running right now, which at boot, before this process's own `RunningCards` has
     * anything in it, can only mean a daemon that no longer exists still holds it.
     */
    async activeCardStageJobs(): Promise<ActiveCardStageJob[]> {
        // Row keys come back camelCased — this pool's plugins (`KyselyDefaultPlugins`) apply
        // `transformResult` to a raw `sql` tag's rows the same as any query-builder result, so the
        // shape below reads `startedOn`, not the `started_on` the query itself names.
        const { rows } = await sql<{ id: string; data: CardStagePayload; startedOn: DateTime | null }>`
            select id, data, started_on from pgboss.job where name = 'card.stage' and state = 'active'
        `.execute(this.db);

        return rows.map(row => ({ jobId: row.id, payload: row.data, startedOn: row.startedOn ?? undefined }));
    }

    /**
     * The `runner.cardJobs` claim row for a given job id, regardless of which project recorded it —
     * card 0272's fallback for an orphaned `card.stage` job whose own payload carries no `project`
     * (`CardStagePayload`'s own doc comment: `BoardWriteService.start` sends none). Unlike every
     * other query on this class, deliberately not scoped by `this.config.project`: the boot sweep
     * that calls this does not yet know which project a given orphaned job belongs to, which is
     * exactly the question this answers.
     */
    async claimForJob(jobId: string): Promise<{ project: string; cardId: string } | undefined> {
        return this.db.selectFrom('runner.cardJobs').select(['project', 'cardId']).where('jobId', '=', jobId).executeTakeFirst();
    }
}
