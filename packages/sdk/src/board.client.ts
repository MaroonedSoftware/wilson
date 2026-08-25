import type {
    BoardColumns,
    CardDetail,
    CardEvent,
    CardSummary,
    CardVersion,
    CreateCardRequest,
    EditCardRequest,
    ListQuery,
    MoveCardRequest,
} from './types/board.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, buildQueryString } from './sdk-options.js';

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

    /** @name Create card */
    async createCard(body: CreateCardRequest): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<CardDetail>(result);
    }

    /** @name Get card */
    async getCard(id: string): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}`, { method: 'GET' });
        return await parseJson<CardDetail>(result);
    }

    /**
     * @name Edit card body
     * @description Not `put`. This is a partial update — only the body changes, frontmatter is not editable here
     * (decision 5: stage, branch, retries are runner state; `move` is the recorded way to override
     * stage) — which is exactly what `patch` means and `put`, a full replace, does not.
     */
    async editCardBody(id: string, body: EditCardRequest): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<CardDetail>(result);
    }

    /**
     * @name Move card
     * @description A sub-resource action rather than `PATCH /api/cards/{id}` with a `stage` field: a move is a
     * recorded transition with its own event (`writeWithEvent`), not an edit to a stored field, and card
     * 0080's other five mutations — depend, ack, approve, start, release — are transitions of exactly
     * this shape. `POST .../move` establishes that convention once so five more operations can copy it
     * rather than each inventing its own.
     */
    async moveCard(id: string, body: MoveCardRequest): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
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
