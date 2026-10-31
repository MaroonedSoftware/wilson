import { Injectable } from 'injectkit';
import type { AutoSplitSetting, SetAutoSplitSettingRequest } from '#src/generated/settings.js';
import { AUTO_SPLIT_ENABLED } from './auto.split.setting.js';
import { SettingsStore } from './settings.store.js';

/**
 * The auto-split switch, contract-facing. Nothing here pushes a change into a running process:
 * `AutoSplitter` reads the setting on every refusal, so persisting the row is already the whole job,
 * the same posture `DryRunSettingService` takes.
 */
@Injectable()
export class AutoSplitSettingService {
    constructor(private readonly settings: SettingsStore) {}

    /** The contract-facing read: the setting's current effective value. */
    async get(): Promise<AutoSplitSetting> {
        return { enabled: await this.settings.get(AUTO_SPLIT_ENABLED) };
    }

    /** The contract-facing write: persist the new value. Nothing to validate — it is a plain switch. */
    async set(body: SetAutoSplitSettingRequest): Promise<AutoSplitSetting> {
        await this.settings.set(AUTO_SPLIT_ENABLED, body.enabled);
        return { enabled: body.enabled };
    }
}
