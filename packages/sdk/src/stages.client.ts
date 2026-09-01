import type { SetStageConfigRequest, StageConfigDocument, StageConfigVersion, StageConfigVersionsQuery } from './types/stages.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [stages.ck](file://./../../../apps/api/data/contracts/stages.ck)
 */
export class StagesClient {
    constructor(private fetch: SdkFetch) {}

    /** @name Get stage config */
    async getStageConfig(): Promise<StageConfigDocument> {
        const result = await this.fetch(`/api/stages/config`, { method: 'GET' });
        return await parseJson<StageConfigDocument>(result);
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
        return await parseJson<StageConfigDocument>(result);
    }

    /** @name List stage config versions */
    async listStageConfigVersions(query?: StageConfigVersionsQuery): Promise<StageConfigVersion[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/stages/config/versions${qs}`, {
            method: 'GET',
        });
        return await parseJson<StageConfigVersion[]>(result);
    }
}
