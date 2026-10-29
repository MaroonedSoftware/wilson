import type {
    CardStageConcurrency,
    ChatEngineSetting,
    ClaudeConfigDirSetting,
    DryRunSetting,
    NotifyWebhookSetting,
    PollerInterval,
    PollerSetting,
    SetCardStageConcurrencyRequest,
    SetClaudeConfigDirSettingRequest,
    SetDryRunSettingRequest,
    SetNotifyWebhookSettingRequest,
    SetPollerIntervalRequest,
    SetPollerSettingRequest,
} from './types/settings.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [settings.ck](../../../apps/api/data/contracts/settings.ck)
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

    /** @name Get poller interval */
    async getPollerInterval(): Promise<PollerInterval> {
        const result = await this.fetch(`/api/settings/poller-interval-ms`, { method: 'GET' });
        return await parseJson<PollerInterval>(result);
    }

    /** @name Set poller interval */
    async setPollerInterval(body: SetPollerIntervalRequest): Promise<PollerInterval> {
        const result = await this.fetch(`/api/settings/poller-interval-ms`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<PollerInterval>(result);
    }

    /** @name Get card stage concurrency */
    async getCardStageConcurrency(): Promise<CardStageConcurrency> {
        const result = await this.fetch(`/api/settings/card-stage-concurrency`, { method: 'GET' });
        return await parseJson<CardStageConcurrency>(result);
    }

    /** @name Set card stage concurrency */
    async setCardStageConcurrency(body: SetCardStageConcurrencyRequest): Promise<CardStageConcurrency> {
        const result = await this.fetch(`/api/settings/card-stage-concurrency`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<CardStageConcurrency>(result);
    }

    /** @name Get notify webhook setting */
    async getNotifyWebhookSetting(): Promise<NotifyWebhookSetting> {
        const result = await this.fetch(`/api/settings/notify-webhook`, { method: 'GET' });
        return await parseJson<NotifyWebhookSetting>(result);
    }

    /** @name Set notify webhook setting */
    async setNotifyWebhookSetting(body: SetNotifyWebhookSettingRequest): Promise<NotifyWebhookSetting> {
        const result = await this.fetch(`/api/settings/notify-webhook`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<NotifyWebhookSetting>(result);
    }

    /** @name Get claude config dir setting */
    async getClaudeConfigDirSetting(): Promise<ClaudeConfigDirSetting> {
        const result = await this.fetch(`/api/settings/claude-config-dir`, { method: 'GET' });
        return await parseJson<ClaudeConfigDirSetting>(result);
    }

    /** @name Set claude config dir setting */
    async setClaudeConfigDirSetting(body: SetClaudeConfigDirSettingRequest): Promise<ClaudeConfigDirSetting> {
        const result = await this.fetch(`/api/settings/claude-config-dir`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<ClaudeConfigDirSetting>(result);
    }

    /** @name Get dry run setting */
    async getDryRunSetting(): Promise<DryRunSetting> {
        const result = await this.fetch(`/api/settings/dry-run`, { method: 'GET' });
        return await parseJson<DryRunSetting>(result);
    }

    /** @name Set dry run setting */
    async setDryRunSetting(body: SetDryRunSettingRequest): Promise<DryRunSetting> {
        const result = await this.fetch(`/api/settings/dry-run`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<DryRunSetting>(result);
    }

    /** @name Get chat engine setting */
    async getChatEngineSetting(): Promise<ChatEngineSetting> {
        const result = await this.fetch(`/api/settings/chat-engine`, { method: 'GET' });
        return await parseJson<ChatEngineSetting>(result);
    }

    /** @name Set chat engine setting */
    async setChatEngineSetting(body: ChatEngineSetting): Promise<ChatEngineSetting> {
        const result = await this.fetch(`/api/settings/chat-engine`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<ChatEngineSetting>(result);
    }
}
