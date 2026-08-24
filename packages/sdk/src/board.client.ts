import type { BoardColumns, CardDetail, CardEvent, CardSummary, CardVersion, ListQuery } from './types/board.js';
import type { SdkFetch } from './sdk-options.js';
import { parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [board.ck](file://./../../../apps/api/data/contracts/board.ck)
 */
export class BoardClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List cards */
    async listCards(): Promise<CardSummary[]> {
        const result = await this.fetch(`/api/cards`, { method: 'GET' });
        return await parseJson<CardSummary[]>(result);
    }

    /** @name Get card */
    async getCard(id: string): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}`, { method: 'GET' });
        return await parseJson<CardDetail>(result);
    }

    /** @name List card events */
    async listCardEvents(id: string, query?: ListQuery): Promise<CardEvent[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/events${qs}`, {
            method: 'GET',
        });
        return await parseJson<CardEvent[]>(result);
    }

    /** @name List card versions */
    async listCardVersions(id: string, query?: ListQuery): Promise<CardVersion[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/versions${qs}`, {
            method: 'GET',
        });
        return await parseJson<CardVersion[]>(result);
    }

    /** @name List board columns */
    async listBoardColumns(): Promise<BoardColumns> {
        const result = await this.fetch(`/api/stages`, { method: 'GET' });
        return await parseJson<BoardColumns>(result);
    }
}
