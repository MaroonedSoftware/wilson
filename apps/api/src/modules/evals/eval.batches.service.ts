import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { BoardConfig } from '#modules/board/board.config.js';
import { HostRepository } from '#modules/host/host.repository.js';
import { LearningsStore } from '#modules/learnings/learnings.store.js';
import { documentFromLanes } from '#modules/stages/lane.rows.js';
import { StageConfigStore } from '#modules/stages/stage.config.store.js';
import type { CreateEvalBatchRequest, EvalBatch, EvalBatchDetail, EvalRun, EvalRunPatch, ListEvalBatchesQuery } from '../../generated/evals.js';
import { summarizeRuns } from './eval.report.js';
import { EvalFixtureRepository } from './eval.fixture.repository.js';
import { EvalRunRepository, type EvalArm, type EvalBatchRow, type EvalRunRow } from './eval.run.repository.js';

/** How much one batch may spend unless it says otherwise. */
const DEFAULT_MAX_OUTPUT_TOKENS = 300_000;
const DEFAULT_RUNS = 3;
const MAX_RUNS = 20;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;

const IS_ID = /^[1-9]\d{0,17}$/;

const batchContract = (batch: EvalBatchRow, spentOutputTokens: number): EvalBatch => ({
    id: batch.id,
    status: batch.status as EvalBatch['status'],
    host: batch.host,
    runsPerFixture: batch.runsPerFixture,
    maxOutputTokens: batch.maxOutputTokens,
    spentOutputTokens,
    ...(batch.stopReason && { stopReason: batch.stopReason }),
    ...(batch.waitingReason && { waitingReason: batch.waitingReason }),
    createdAt: batch.createdAt,
    ...(batch.finishedAt && { finishedAt: batch.finishedAt }),
});

const runContract = (run: EvalRunRow): EvalRun => ({
    id: run.id,
    fixtureId: run.fixtureId,
    arm: run.arm,
    status: run.status,
    failures: run.failures,
    unjudged: run.unjudged,
    reportRejected: run.reportRejected,
    truncated: run.truncated,
    hasPatch: run.patch !== undefined,
    ...(run.error && { error: run.error }),
    ...(run.wallClockMs !== undefined && { wallClockMs: run.wallClockMs }),
    ...(run.inputTokens !== undefined && { inputTokens: run.inputTokens }),
    ...(run.cachedInputTokens !== undefined && { cachedInputTokens: run.cachedInputTokens }),
    ...(run.outputTokens !== undefined && { outputTokens: run.outputTokens }),
    ...(run.toolCalls !== undefined && { toolCalls: run.toolCalls }),
    ...(run.scopeDenials !== undefined && { scopeDenials: run.scopeDenials }),
});

/**
 * Runs in the order that keeps the arms comparable: each fixture's arms alternate, so a slow hour or
 * a model's bad afternoon falls on both rather than on whichever arm happened to run then.
 */
export const orderRuns = (fixtureIds: readonly string[], arms: readonly EvalArm[], runs: number): { fixtureId: string; arm: EvalArm }[] =>
    fixtureIds.flatMap(fixtureId => Array.from({ length: runs }, () => arms.map(arm => ({ fixtureId, arm }))).flat());

/** Starting a batch and reading what it found. Never touches a card or a lane. */
@Injectable()
export class EvalBatchesService {
    constructor(
        private readonly config: BoardConfig,
        private readonly runs: EvalRunRepository,
        private readonly fixtures: EvalFixtureRepository,
        private readonly hosts: HostRepository,
        private readonly stages: StageConfigStore,
        private readonly learnings: LearningsStore,
        private readonly broker: JobBroker,
    ) {}

    async create({ fixtureIds, host, runs, maxOutputTokens }: CreateEvalBatchRequest): Promise<EvalBatchDetail> {
        const perFixture = runs ?? DEFAULT_RUNS;
        if (perFixture < 1 || perFixture > MAX_RUNS) {
            throw httpError(400).withDetails({ reason: `runs must be between 1 and ${MAX_RUNS}` });
        }
        const limit = maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
        if (limit < 1) throw httpError(400).withDetails({ reason: 'maxOutputTokens must be at least 1' });
        const unique = [...new Set(fixtureIds)];
        if (unique.length === 0) throw httpError(400).withDetails({ reason: 'name at least one fixture' });

        for (const id of unique) {
            if (!IS_ID.test(id) || !(await this.fixtures.find(id))) throw httpError(404).withDetails({ reason: `no fixture ${id}` });
        }
        const row = await this.hosts.find(host);
        if (!row) throw httpError(404).withDetails({ reason: `no host named "${host}"` });

        const batch = await this.runs.createBatch({
            host,
            runsPerFixture: perFixture,
            maxOutputTokens: limit,
            currentLanes: documentFromLanes(await this.stages.laneConfig()),
            learnings: await this.learnings.load(),
            runs: orderRuns(unique, ['current'], perFixture),
        });
        await this.broker.send('eval.run', { batchId: batch.id, project: this.config.project });
        return this.show(batch.id);
    }

    async list(query: ListEvalBatchesQuery): Promise<EvalBatch[]> {
        const limit = Math.min(query.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const batches = await this.runs.listBatches(limit);
        return Promise.all(batches.map(async batch => batchContract(batch, await this.runs.outputTokensSpent(batch.id))));
    }

    async show(id: string): Promise<EvalBatchDetail> {
        const batch = await this.requireBatch(id);
        const runs = await this.runs.runs(id);
        return {
            batch: batchContract(batch, await this.runs.outputTokensSpent(id)),
            runs: runs.map(runContract),
            summary: summarizeRuns(runs),
        };
    }

    async stop(id: string): Promise<EvalBatchDetail> {
        await this.requireBatch(id);
        await this.runs.stopBatch(id, 'stopped by the operator');
        return this.show(id);
    }

    async patch(id: string): Promise<EvalRunPatch> {
        const run = IS_ID.test(id) ? await this.runs.run(id) : undefined;
        if (!run) throw httpError(404).withDetails({ reason: `no eval run ${id}` });
        return { patch: run.patch ?? '', truncated: run.patchTruncated };
    }

    private async requireBatch(id: string): Promise<EvalBatchRow> {
        const batch = IS_ID.test(id) ? await this.runs.batch(id) : undefined;
        if (!batch) throw httpError(404).withDetails({ reason: `no eval batch ${id}` });
        return batch;
    }
}
