import type { EngineTokenSummary, PutEngineTokenRequest } from './types/engine.tokens.js';
import { reviveEngineTokenSummary } from './types/engine.tokens.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [engine.tokens.ck](../../../apps/api/data/contracts/engine.tokens.ck)
 */
export class EngineTokensClient {
    constructor(private fetch: SdkFetch) {}

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
     * @name Remove engine token
     * @description Forget a token. This does not revoke it with Anthropic, and an engine already running keeps it.
     * Hosts assigned it go back to the worker's own sign-in.
     */
    async removeEngineToken(name: string): Promise<void> {
        await this.fetch(`/api/engine-tokens/${encodeURIComponent(name)}`, { method: 'DELETE' });
    }
}
