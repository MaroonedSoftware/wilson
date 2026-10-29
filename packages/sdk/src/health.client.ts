import type { Health } from './types/health.js';
import { reviveHealth } from './types/health.js';
import type { SdkFetch } from './sdk-options.js';
import { parseJson } from './sdk-options.js';

/**
 * generated from [health.ck](../../../apps/api/data/contracts/health.ck)
 */
export class HealthClient {
    constructor(private fetch: SdkFetch) {}

    /** @name Health */
    async getHealth(): Promise<Health> {
        const result = await this.fetch(`/api/health`, { method: 'GET' });
        return reviveHealth(await parseJson<Health>(result));
    }
}
