import type {
    AppV1ActivityEvent,
    AppV1ActivityQuery,
    AppV1BoardColumns,
    AppV1Card,
    AppV1CardDetail,
    AppV1Stats,
    AppV1StatsQuery,
} from './types/app.api.js';
import { reviveAppV1ActivityEvent, reviveAppV1Card, reviveAppV1CardDetail, reviveAppV1Stats } from './types/app.api.js';
import type { SdkFetch } from './sdk-options.js';
import { parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [app.api.ck](../../../apps/api/data/contracts/app.api.ck)
 */
export class AppApiClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List cards for an app */
    async listCardsV1(): Promise<AppV1Card[]> {
        const result = await this.fetch(`/api/app-api/v1/cards`, { method: 'GET' });
        return (await parseJson<AppV1Card[]>(result)).map(reviveAppV1Card);
    }

    /** @name Get a card for an app */
    async getCardV1(id: string): Promise<AppV1CardDetail> {
        const result = await this.fetch(`/api/app-api/v1/cards/${encodeURIComponent(id)}`, { method: 'GET' });
        return reviveAppV1CardDetail(await parseJson<AppV1CardDetail>(result));
    }

    /** @name List board columns for an app */
    async listBoardColumnsV1(): Promise<AppV1BoardColumns> {
        const result = await this.fetch(`/api/app-api/v1/columns`, { method: 'GET' });
        return await parseJson<AppV1BoardColumns>(result);
    }

    /** @name List project activity for an app */
    async listProjectActivityV1(query?: AppV1ActivityQuery): Promise<AppV1ActivityEvent[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/app-api/v1/activity${qs}`, {
            method: 'GET',
        });
        return (await parseJson<AppV1ActivityEvent[]>(result)).map(reviveAppV1ActivityEvent);
    }

    /** @name Get project stats for an app */
    async getProjectStatsV1(query?: AppV1StatsQuery): Promise<AppV1Stats> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/app-api/v1/stats${qs}`, {
            method: 'GET',
        });
        return reviveAppV1Stats(await parseJson<AppV1Stats>(result));
    }
}
