import type { PutSecretRequest, SecretSummary } from './types/secrets.js';
import { reviveSecretSummary } from './types/secrets.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [secrets.ck](../../../apps/api/data/contracts/secrets.ck)
 */
export class SecretsClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List secrets */
    async listSecrets(): Promise<SecretSummary[]> {
        const result = await this.fetch(`/api/secrets`, { method: 'GET' });
        return (await parseJson<SecretSummary[]>(result)).map(reviveSecretSummary);
    }

    /**
     * @name Put secret
     * @description Save a value under `name`, replacing any saved there, so rotating is putting again.
     */
    async putSecret(name: string, body: PutSecretRequest): Promise<SecretSummary> {
        const result = await this.fetch(`/api/secrets/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveSecretSummary(await parseJson<SecretSummary>(result));
    }

    /**
     * @name Remove secret
     * @description Forget a secret. This does not revoke it with whoever issued it.
     */
    async removeSecret(name: string): Promise<void> {
        await this.fetch(`/api/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    }
}
