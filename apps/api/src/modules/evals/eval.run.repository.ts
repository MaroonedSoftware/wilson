import { Injectable } from 'injectkit';
import { Kysely, sql, type Selectable } from 'kysely';
import { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB, Json, WilsonEvalBatches, WilsonEvalRuns } from '#modules/data/db.js';

export type EvalArm = 'current' | 'candidate';
export type EvalRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'errored' | 'interrupted' | 'abandoned' | 'skipped';

export interface EvalBatchRow {
    id: string;
    project: string;
    host: string;
    status: string;
    stopReason?: string;
    waitingReason?: string;
    runsPerFixture: number;
    maxOutputTokens: number;
    currentLanes: unknown;
    candidateLanes?: unknown;
    candidate?: unknown;
    learnings: string;
    createdAt: DateTime;
    finishedAt?: DateTime;
}

export interface EvalRunRow {
    id: string;
    batchId: string;
    fixtureId: string;
    arm: EvalArm;
    position: number;
    status: EvalRunStatus;
    failures: string[];
    unjudged: boolean;
    reportRejected: boolean;
    truncated: boolean;
    error?: string;
    result?: unknown;
    patch?: string;
    patchTruncated: boolean;
    wallClockMs?: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    toolCalls?: number;
    scopeDenials?: number;
    startedAt?: DateTime;
    finishedAt?: DateTime;
}

export interface NewEvalBatch {
    host: string;
    runsPerFixture: number;
    maxOutputTokens: number;
    currentLanes: unknown;
    candidateLanes?: unknown;
    candidate?: unknown;
    learnings: string;
    runs: { fixtureId: string; arm: EvalArm }[];
}

/** How a run ended, for {@link EvalRunRepository.finishRun}. */
export type EvalRunEnding = Pick<EvalRunRow, 'status'> &
    Partial<
        Pick<
            EvalRunRow,
            | 'failures'
            | 'unjudged'
            | 'reportRejected'
            | 'truncated'
            | 'error'
            | 'result'
            | 'patch'
            | 'patchTruncated'
            | 'wallClockMs'
            | 'inputTokens'
            | 'cachedInputTokens'
            | 'outputTokens'
            | 'toolCalls'
            | 'scopeDenials'
        >
    >;

const toBatch = (row: Selectable<WilsonEvalBatches>): EvalBatchRow => ({
    id: String(row.id),
    project: row.project,
    host: row.host,
    status: row.status,
    ...(row.stopReason !== null && { stopReason: row.stopReason }),
    ...(row.waitingReason !== null && { waitingReason: row.waitingReason }),
    runsPerFixture: row.runsPerFixture,
    maxOutputTokens: row.maxOutputTokens,
    currentLanes: row.currentLanes,
    ...(row.candidateLanes !== null && { candidateLanes: row.candidateLanes }),
    ...(row.candidate !== null && { candidate: row.candidate }),
    learnings: row.learnings,
    createdAt: row.createdAt,
    ...(row.finishedAt !== null && { finishedAt: row.finishedAt }),
});

const toRun = (row: Selectable<WilsonEvalRuns>): EvalRunRow => ({
    id: String(row.id),
    batchId: String(row.batchId),
    fixtureId: String(row.fixtureId),
    arm: row.arm as EvalArm,
    position: row.position,
    status: row.status as EvalRunStatus,
    failures: row.failures as string[],
    unjudged: row.unjudged,
    reportRejected: row.reportRejected,
    truncated: row.truncated,
    ...(row.error !== null && { error: row.error }),
    ...(row.result !== null && { result: row.result }),
    ...(row.patch !== null && { patch: row.patch }),
    patchTruncated: row.patchTruncated,
    ...(row.wallClockMs !== null && { wallClockMs: row.wallClockMs }),
    ...(row.inputTokens !== null && { inputTokens: row.inputTokens }),
    ...(row.cachedInputTokens !== null && { cachedInputTokens: row.cachedInputTokens }),
    ...(row.outputTokens !== null && { outputTokens: row.outputTokens }),
    ...(row.toolCalls !== null && { toolCalls: row.toolCalls }),
    ...(row.scopeDenials !== null && { scopeDenials: row.scopeDenials }),
    ...(row.startedAt !== null && { startedAt: row.startedAt }),
    ...(row.finishedAt !== null && { finishedAt: row.finishedAt }),
});

/** `wilson.eval_batches` and `wilson.eval_runs`. Per project, except what the boot sweep needs. */
@Injectable()
export class EvalRunRepository {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {}

    async createBatch(batch: NewEvalBatch): Promise<EvalBatchRow> {
        return this.db.transaction().execute(async trx => {
            const row = await trx
                .insertInto('wilson.evalBatches')
                .values({
                    project: this.config.project,
                    host: batch.host,
                    runsPerFixture: batch.runsPerFixture,
                    maxOutputTokens: batch.maxOutputTokens,
                    currentLanes: JSON.stringify(batch.currentLanes) as unknown as Json,
                    candidateLanes: batch.candidateLanes === undefined ? null : (JSON.stringify(batch.candidateLanes) as unknown as Json),
                    candidate: batch.candidate === undefined ? null : (JSON.stringify(batch.candidate) as unknown as Json),
                    learnings: batch.learnings,
                    finishedAt: null,
                    stopReason: null,
                    waitingReason: null,
                })
                .returningAll()
                .executeTakeFirstOrThrow();
            await trx
                .insertInto('wilson.evalRuns')
                .values(
                    batch.runs.map((run, position) => ({
                        project: this.config.project,
                        batchId: row.id,
                        fixtureId: BigInt(run.fixtureId),
                        arm: run.arm,
                        position,
                        cachedInputTokens: null,
                        error: null,
                        finishedAt: null,
                        inputTokens: null,
                        outputTokens: null,
                        patch: null,
                        result: null,
                        scopeDenials: null,
                        startedAt: null,
                        toolCalls: null,
                        wallClockMs: null,
                    })),
                )
                .execute();
            return toBatch(row);
        });
    }

    async batch(id: string): Promise<EvalBatchRow | undefined> {
        const row = await this.db
            .selectFrom('wilson.evalBatches')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('id', '=', BigInt(id))
            .executeTakeFirst();
        return row ? toBatch(row) : undefined;
    }

    async listBatches(limit: number): Promise<EvalBatchRow[]> {
        const rows = await this.db
            .selectFrom('wilson.evalBatches')
            .selectAll()
            .where('project', '=', this.config.project)
            .orderBy('id', 'desc')
            .limit(limit)
            .execute();
        return rows.map(toBatch);
    }

    /** A batch's runs, in the order they run. */
    async runs(batchId: string): Promise<EvalRunRow[]> {
        const rows = await this.db
            .selectFrom('wilson.evalRuns')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('batchId', '=', BigInt(batchId))
            .orderBy('position')
            .execute();
        return rows.map(toRun);
    }

    async run(id: string): Promise<EvalRunRow | undefined> {
        const row = await this.db
            .selectFrom('wilson.evalRuns')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('id', '=', BigInt(id))
            .executeTakeFirst();
        return row ? toRun(row) : undefined;
    }

    async outputTokensSpent(batchId: string): Promise<number> {
        const row = await this.db
            .selectFrom('wilson.evalRuns')
            .select(sql<string>`coalesce(sum(output_tokens), 0)`.as('total'))
            .where('batchId', '=', BigInt(batchId))
            .executeTakeFirstOrThrow();
        return Number(row.total);
    }

    /** Take the batch's next queued run for this job. Answers `undefined` when none is left. */
    async claimNext(batchId: string): Promise<EvalRunRow | undefined> {
        const next = await this.db
            .selectFrom('wilson.evalRuns')
            .select('id')
            .where('batchId', '=', BigInt(batchId))
            .where('status', '=', 'queued')
            .orderBy('position')
            .limit(1)
            .executeTakeFirst();
        if (!next) return undefined;
        const row = await this.db
            .updateTable('wilson.evalRuns')
            .set({ status: 'running', startedAt: DateTime.now() })
            .where('id', '=', next.id)
            .where('status', '=', 'queued')
            .returningAll()
            .executeTakeFirst();
        return row ? toRun(row) : undefined;
    }

    /** Give a claimed run back, for a host with no slot free right now. */
    async releaseRun(id: string): Promise<void> {
        await this.db.updateTable('wilson.evalRuns').set({ status: 'queued', startedAt: null }).where('id', '=', BigInt(id)).execute();
    }

    async finishRun(id: string, ending: EvalRunEnding): Promise<void> {
        const { failures, result, ...columns } = ending;
        await this.db
            .updateTable('wilson.evalRuns')
            .set({
                ...columns,
                ...(failures && { failures: JSON.stringify(failures) as unknown as Json }),
                ...(result !== undefined && { result: JSON.stringify(result) as unknown as Json }),
                finishedAt: DateTime.now(),
            })
            .where('id', '=', BigInt(id))
            .execute();
    }

    async hasRunning(batchId: string): Promise<boolean> {
        const row = await this.db
            .selectFrom('wilson.evalRuns')
            .select('id')
            .where('batchId', '=', BigInt(batchId))
            .where('status', '=', 'running')
            .limit(1)
            .executeTakeFirst();
        return row !== undefined;
    }

    async setWaiting(batchId: string, reason: string | undefined): Promise<void> {
        await this.db
            .updateTable('wilson.evalBatches')
            .set({ waitingReason: reason ?? null })
            .where('id', '=', BigInt(batchId))
            .execute();
    }

    async finishBatch(batchId: string): Promise<void> {
        await this.db
            .updateTable('wilson.evalBatches')
            .set({ status: 'finished', finishedAt: DateTime.now(), waitingReason: null })
            .where('id', '=', BigInt(batchId))
            .where('status', '=', 'running')
            .execute();
    }

    /** End a batch early. What has not started is skipped; what is running finishes and is kept. */
    async stopBatch(batchId: string, reason: string): Promise<void> {
        await this.db.transaction().execute(async trx => {
            await trx
                .updateTable('wilson.evalBatches')
                .set({ status: 'stopped', stopReason: reason, finishedAt: DateTime.now(), waitingReason: null })
                .where('id', '=', BigInt(batchId))
                .where('status', '=', 'running')
                .execute();
            await trx
                .updateTable('wilson.evalRuns')
                .set({ status: 'skipped' })
                .where('batchId', '=', BigInt(batchId))
                .where('status', '=', 'queued')
                .execute();
        });
    }

    /**
     * Across every project, at boot: runs left `running` belong to a process that is gone, and their
     * batches have nothing carrying them any more. Answers those batches, and every other batch with
     * work left, so each can be sent again.
     */
    async abandonStranded(): Promise<{ id: string; project: string }[]> {
        await this.db
            .updateTable('wilson.evalRuns')
            .set({ status: 'abandoned', error: 'the daemon stopped during this run', finishedAt: DateTime.now() })
            .where('status', '=', 'running')
            .execute();
        const rows = await this.db.selectFrom('wilson.evalBatches').select(['id', 'project']).where('status', '=', 'running').execute();
        return rows.map(row => ({ id: String(row.id), project: row.project }));
    }
}
