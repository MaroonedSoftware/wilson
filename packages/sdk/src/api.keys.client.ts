import type { ApiKeySummary, CreateApiKeyRequest, IssuedApiKey } from './types/api.keys.js';
import { reviveApiKeySummary, reviveIssuedApiKey } from './types/api.keys.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [api.keys.ck](../../../apps/api/data/contracts/api.keys.ck)
 */
export class ApiKeysClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List API keys */
    async listApiKeys(): Promise<ApiKeySummary[]> {
        const result = await this.fetch(`/api/auth/keys`, { method: 'GET' });
        return (await parseJson<ApiKeySummary[]>(result)).map(reviveApiKeySummary);
    }

    /** @name Create an API key */
    async createApiKey(body: CreateApiKeyRequest): Promise<IssuedApiKey> {
        const result = await this.fetch(`/api/auth/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveIssuedApiKey(await parseJson<IssuedApiKey>(result));
    }

    /** @name Rotate an API key */
    async rotateApiKey(id: string): Promise<IssuedApiKey> {
        const result = await this.fetch(`/api/auth/keys/${encodeURIComponent(id)}/rotate`, { method: 'POST' });
        return reviveIssuedApiKey(await parseJson<IssuedApiKey>(result));
    }

    /** @name Revoke an API key */
    async revokeApiKey(id: string): Promise<ApiKeySummary> {
        const result = await this.fetch(`/api/auth/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
        return reviveApiKeySummary(await parseJson<ApiKeySummary>(result));
    }
}
