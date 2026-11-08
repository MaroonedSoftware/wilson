import type {
    EngineAccountUsage,
    EngineAccountUsageQuery,
    EngineLimit,
    EngineTokenSummary,
    PutEngineTokenRequest,
    RenameEngineTokenRequest,
    UpdateEngineTokenRequest,
} from './types/engine.tokens.js';
import { reviveEngineLimit, reviveEngineTokenSummary } from './types/engine.tokens.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [engine.tokens.ck](../../../apps/api/data/contracts/engine.tokens.ck)
 */
export class EngineTokensClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List engine limits */
    async listEngineLimits(): Promise<EngineLimit[]> {
        const result = await this.fetch(`/api/engine-limits`, { method: 'GET' });
        return (await parseJson<EngineLimit[]>(result)).map(reviveEngineLimit);
    }

    /** @name List engine tokens */
    async listEngineTokens(): Promise<EngineTokenSummary[]> {
        const result = await this.fetch(`/api/engine-tokens`, { method: 'GET' });
        return (await parseJson<EngineTokenSummary[]>(result)).map(reviveEngineTokenSummary);
    }

    /**
     * @name Put engine token
     * @description Save a token under `name`, replacing any saved there, so rotating is putting again. A new value
     * reaches the next engine started with it, never one already running.
     */
    async putEngineToken(name: string, body: PutEngineTokenRequest): Promise<EngineTokenSummary> {
        const result = await this.fetch(`/api/engine-tokens/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveEngineTokenSummary(await parseJson<EngineTokenSummary>(result));
    }

    /**
     * @name Update engine token
     * @description Change what is recorded about a saved token, keeping the token and what it has hit.
     */
    async updateEngineToken(name: string, body: UpdateEngineTokenRequest): Promise<EngineTokenSummary> {
        const result = await this.fetch(`/api/engine-tokens/${encodeURIComponent(name)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveEngineTokenSummary(await parseJson<EngineTokenSummary>(result));
    }

    /**
     * @name Remove engine token
     * @description Forget a token. This does not revoke it with Anthropic, and an engine already running keeps it.
     * Hosts assigned it go back to the worker's own sign-in.
     */
    async removeEngineToken(name: string): Promise<void> {
        await this.fetch(`/api/engine-tokens/${encodeURIComponent(name)}`, { method: 'DELETE' });
    }

    /**
     * @name Rename engine token
     * @description A sub-resource action rather than a `name` field on `UpdateEngineTokenRequest`, which would change
     * what the generated `updateEngineToken` means for every caller. The name is the key, so this is the
     * only way to change it without removing the token and saving it again, which loses it: the token
     * cannot be read back.
     *
     * What moves: the token's own row, and the assignment of every worker host that holds it — the latter
     * by the foreign key's `ON UPDATE CASCADE`, not by a second write. What does not: the token itself, its
     * `provider`, `kind`, `priority`, `pooled`, `createdAt` and `updatedAt` (a rename is not a re-save);
     * recorded spend, which keeps the old name, so `GET /api/engine-accounts/usage` lists the old and the
     * new name separately for a window that straddles a rename; and a usage limit in force, which stays
     * recorded against the old name. Renaming to the current name is a no-op, not an error.
     *
     * A rename does not reach a running engine. An engine is started with the account name resolved then
     * and handed the token's value, never its name, so a run in flight carries on untouched and the next
     * engine started gets the new name. A limit a running engine reports after the rename is therefore
     * recorded against the old name: it shows as a stray account in `GET /api/engine-limits` until it
     * resets, and the renamed account shows no badge for it — as `put` never reaches a running engine
     * either.
     */
    async renameEngineToken(name: string, body: RenameEngineTokenRequest): Promise<EngineTokenSummary> {
        const result = await this.fetch(`/api/engine-tokens/${encodeURIComponent(name)}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveEngineTokenSummary(await parseJson<EngineTokenSummary>(result));
    }

    /**
     * @name List engine account usage
     * @description Each account that spent anything in the window, most output first.
     */
    async listEngineAccountUsage(query?: EngineAccountUsageQuery): Promise<EngineAccountUsage[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/engine-accounts/usage${qs}`, {
            method: 'GET',
        });
        return await parseJson<EngineAccountUsage[]>(result);
    }
}
