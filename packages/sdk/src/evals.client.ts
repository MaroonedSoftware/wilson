import type {
    CaptureEvalFixtureRequest,
    CreateEvalBatchRequest,
    EvalBatch,
    EvalBatchDetail,
    EvalFixture,
    EvalRunPatch,
    ListEvalBatchesQuery,
} from './types/evals.js';
import { reviveEvalBatch, reviveEvalBatchDetail, reviveEvalFixture } from './types/evals.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [evals.ck](../../../apps/api/data/contracts/evals.ck)
 */
export class EvalsClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List eval fixtures */
    async listEvalFixtures(): Promise<EvalFixture[]> {
        const result = await this.fetch(`/api/evals/fixtures`, { method: 'GET' });
        return (await parseJson<EvalFixture[]>(result)).map(reviveEvalFixture);
    }

    /** @name Capture eval fixture */
    async captureEvalFixture(body: CaptureEvalFixtureRequest): Promise<EvalFixture> {
        const result = await this.fetch(`/api/evals/fixtures`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveEvalFixture(await parseJson<EvalFixture>(result));
    }

    /** @name Remove eval fixture */
    async removeEvalFixture(id: string): Promise<void> {
        await this.fetch(`/api/evals/fixtures/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }

    /**
     * @name List eval batches
     * @description Starting a batch needs `wilson.step.up`, as saving a lane does: it spends tokens and runs a config
     * nobody has saved, so a leaked `manage` key must not be able to.
     */
    async listEvalBatches(query?: ListEvalBatchesQuery): Promise<EvalBatch[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/evals/batches${qs}`, {
            method: 'GET',
        });
        return (await parseJson<EvalBatch[]>(result)).map(reviveEvalBatch);
    }

    /**
     * @name Create eval batch
     * @description Starting a batch needs `wilson.step.up`, as saving a lane does: it spends tokens and runs a config
     * nobody has saved, so a leaked `manage` key must not be able to.
     */
    async createEvalBatch(body: CreateEvalBatchRequest): Promise<EvalBatchDetail> {
        const result = await this.fetch(`/api/evals/batches`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveEvalBatchDetail(await parseJson<EvalBatchDetail>(result));
    }

    /** @name Get eval batch */
    async getEvalBatch(id: string): Promise<EvalBatchDetail> {
        const result = await this.fetch(`/api/evals/batches/${encodeURIComponent(id)}`, { method: 'GET' });
        return reviveEvalBatchDetail(await parseJson<EvalBatchDetail>(result));
    }

    /**
     * @name Stop eval batch
     * @description What has not started is skipped. A run in progress finishes and is kept.
     */
    async stopEvalBatch(id: string): Promise<EvalBatchDetail> {
        const result = await this.fetch(`/api/evals/batches/${encodeURIComponent(id)}/stop`, { method: 'POST' });
        return reviveEvalBatchDetail(await parseJson<EvalBatchDetail>(result));
    }

    /**
     * @name Get eval run patch
     * @description What a run left in its tree, cut at 256 KB. Empty for a run that changed nothing.
     */
    async getEvalRunPatch(id: string): Promise<EvalRunPatch> {
        const result = await this.fetch(`/api/evals/runs/${encodeURIComponent(id)}/patch`, { method: 'GET' });
        return await parseJson<EvalRunPatch>(result);
    }
}
