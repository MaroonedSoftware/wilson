import { Injectable } from 'injectkit';
import type { AutoPlanSetting, SetAutoPlanSettingRequest } from '#src/generated/settings.js';
import { AUTO_PLAN_ENABLED } from './auto.plan.setting.js';
import { SettingsStore } from './settings.store.js';

/**
 * The auto-plan switch, contract-facing. Nothing here pushes a change into a running process: the
 * poller reads the setting every tick and `PlanDraftJob` again when it runs, so persisting the row is
 * already the whole job, the same posture `AutoSplitSettingService` takes.
 */
@Injectable()
export class AutoPlanSettingService {
    constructor(private readonly settings: SettingsStore) {}

    /** The contract-facing read: the setting's current effective value. */
    async get(): Promise<AutoPlanSetting> {
        return { enabled: await this.settings.get(AUTO_PLAN_ENABLED) };
    }

    /** The contract-facing write: persist the new value. Nothing to validate — it is a plain switch. */
    async set(body: SetAutoPlanSettingRequest): Promise<AutoPlanSetting> {
        await this.settings.set(AUTO_PLAN_ENABLED, body.enabled);
        return { enabled: body.enabled };
    }
}
