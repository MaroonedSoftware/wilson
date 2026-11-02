import type {
    SetStageConfigRequest,
    SetStageRoutingRequest,
    StageConfigDocument,
    StageConfigVersion,
    StageConfigVersionsQuery,
    StageRouting,
} from './types/stages.js';
import { reviveStageConfigDocument, reviveStageConfigVersion } from './types/stages.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [stages.ck](../../../apps/api/data/contracts/stages.ck)
 */
export class StagesClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List stage routing */
    async listStageRouting(): Promise<StageRouting[]> {
        const result = await this.fetch(`/api/stages/routing`, { method: 'GET' });
        return await parseJson<StageRouting[]>(result);
    }

    /**
     * @name Set stage routing
     * @description One stage at a time, unlike the document. Behind step-up for the same reason the document is, and
     * because an agent that could choose its own model could choose the most expensive one.
     */
    async setStageRouting(stage: string, body: SetStageRoutingRequest): Promise<StageRouting> {
        const result = await this.fetch(`/api/stages/routing/${encodeURIComponent(stage)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<StageRouting>(result);
    }

    /** @name Get stage config */
    async getStageConfig(): Promise<StageConfigDocument> {
        const result = await this.fetch(`/api/stages/config`, { method: 'GET' });
        return reviveStageConfigDocument(await parseJson<StageConfigDocument>(result));
    }

    /**
     * @name Set stage config
     * @description `put`, not `patch`: the document is replaced whole. Every save is a new row; the previous
     * document is still there in the history, so a bad edit is undone by saving the earlier text
     * again, never by deleting anything.
     */
    async setStageConfig(body: SetStageConfigRequest): Promise<StageConfigDocument> {
        const result = await this.fetch(`/api/stages/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveStageConfigDocument(await parseJson<StageConfigDocument>(result));
    }

    /** @name List stage config versions */
    async listStageConfigVersions(query?: StageConfigVersionsQuery): Promise<StageConfigVersion[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/stages/config/versions${qs}`, {
            method: 'GET',
        });
        return (await parseJson<StageConfigVersion[]>(result)).map(reviveStageConfigVersion);
    }
}
