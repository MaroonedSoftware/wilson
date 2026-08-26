import type { PollerSetting, SetPollerSettingRequest } from './types/settings.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [settings.ck](file://./../../../apps/api/data/contracts/settings.ck)
 */
export class SettingsClient {
    constructor(private fetch: SdkFetch) {}

    /** @name Get poller setting */
    async getPollerSetting(): Promise<PollerSetting> {
        const result = await this.fetch(`/api/settings/poller-enabled`, { method: 'GET' });
        return await parseJson<PollerSetting>(result);
    }

    /** @name Set poller setting */
    async setPollerSetting(body: SetPollerSettingRequest): Promise<PollerSetting> {
        const result = await this.fetch(`/api/settings/poller-enabled`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<PollerSetting>(result);
    }
}
