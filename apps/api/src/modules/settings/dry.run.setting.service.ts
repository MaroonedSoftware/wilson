import { Injectable } from 'injectkit';
import type { DryRunSetting, SetDryRunSettingRequest } from '#src/generated/settings.js';
import { SettingsStore } from './settings.store.js';
import { DRY_RUN_ENABLED } from './dry.run.setting.js';

/**
 * The dry-run switch, contract-facing (card 0144).
 *
 * Nothing here needs to push a change into a running process the way `PollerSettingService.set`
 * pushes into `Poller.start`/`stop`: `BoardWriteService.merge` reads `SettingsStore.get(DRY_RUN_ENABLED)`
 * fresh on every merge attempt, so persisting the row is already the whole job, the same posture
 * `PollerIntervalSettingService`/`ClaudeConfigDirSettingService` take for a setting nothing needs
 * applied at write time.
 */
@Injectable()
export class DryRunSettingService {
    constructor(private readonly settings: SettingsStore) {}

    /** The contract-facing read: the setting's current effective value. */
    async get(): Promise<DryRunSetting> {
        return { enabled: await this.settings.get(DRY_RUN_ENABLED) };
    }

    /** The contract-facing write: persist the new value. Nothing to validate — it is a plain switch. */
    async set(body: SetDryRunSettingRequest): Promise<DryRunSetting> {
        await this.settings.set(DRY_RUN_ENABLED, body.enabled);
        return { enabled: body.enabled };
    }
}
