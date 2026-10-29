import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { LOCAL_STAGE_SLOTS_MAX, LOCAL_STAGE_SLOTS_MIN } from '#modules/jobs/job.runner.config.js';
import type { LocalStageSlots, SetLocalStageSlotsRequest } from '#src/generated/settings.js';
import { SettingsStore } from './settings.store.js';
import { LOCAL_STAGE_SLOTS } from './local.stage.slots.setting.js';

/**
 * How many stages may hold a worktree on this machine at once (`local-stage-slots`). Read on every
 * dispatch, so a write takes effect on the next stage with nothing to restart.
 */
@Injectable()
export class LocalStageSlotsSettingService {
    constructor(private readonly settings: SettingsStore) {}

    async get(): Promise<LocalStageSlots> {
        return { slots: await this.settings.get(LOCAL_STAGE_SLOTS) };
    }

    /** Refuse an out-of-range value with a sentence, as `CardStageConcurrencySettingService` does. */
    async set(body: SetLocalStageSlotsRequest): Promise<LocalStageSlots> {
        if (!Number.isInteger(body.slots) || body.slots < LOCAL_STAGE_SLOTS_MIN || body.slots > LOCAL_STAGE_SLOTS_MAX) {
            throw httpError(400).withDetails({
                reason: `local stage slots must be between ${LOCAL_STAGE_SLOTS_MIN} and ${LOCAL_STAGE_SLOTS_MAX}`,
            });
        }
        await this.settings.set(LOCAL_STAGE_SLOTS, body.slots);
        return { slots: body.slots };
    }
}
