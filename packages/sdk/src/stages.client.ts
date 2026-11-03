import type { Lane, LaneRevision, LaneRevisionsQuery, PatchLaneRequest, SetStageRoutingRequest, StageRouting } from './types/stages.js';
import { reviveLaneRevision } from './types/stages.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [stages.ck](../../../apps/api/data/contracts/stages.ck)
 */
export class StagesClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List lanes */
    async listLanes(): Promise<Lane[]> {
        const result = await this.fetch(`/api/stages/lanes`, { method: 'GET' });
        return await parseJson<Lane[]>(result);
    }

    /** @name Update lane */
    async updateLane(name: string, body: PatchLaneRequest): Promise<Lane> {
        const result = await this.fetch(`/api/stages/lanes/${encodeURIComponent(name)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<Lane>(result);
    }

    /** @name List lane revisions */
    async listLaneRevisions(query?: LaneRevisionsQuery): Promise<LaneRevision[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/stages/lane-revisions${qs}`, {
            method: 'GET',
        });
        return (await parseJson<LaneRevision[]>(result)).map(reviveLaneRevision);
    }

    /** @name List stage routing */
    async listStageRouting(): Promise<StageRouting[]> {
        const result = await this.fetch(`/api/stages/routing`, { method: 'GET' });
        return await parseJson<StageRouting[]>(result);
    }

    /**
     * @name Set stage routing
     * @description One lane at a time. Behind step-up for the same reason lane edits are, and
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
}
