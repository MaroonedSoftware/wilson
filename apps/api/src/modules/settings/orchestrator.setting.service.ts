import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import type { OrchestratorSetting, SetOrchestratorSettingRequest } from '#src/generated/settings.js';
import { ORCHESTRATOR_CEILING_MINIMUM, ORCHESTRATOR_DAILY_OUTPUT_TOKENS, ORCHESTRATOR_ENABLED } from './orchestrator.setting.js';
import { SettingsStore } from './settings.store.js';

/** The orchestrator's switch and spending ceiling, contract-facing. Both are read fresh where they are used. */
@Injectable()
export class OrchestratorSettingService {
    constructor(private readonly settings: SettingsStore) {}

    async get(): Promise<OrchestratorSetting> {
        return {
            enabled: await this.settings.get(ORCHESTRATOR_ENABLED),
            dailyOutputTokens: await this.settings.get(ORCHESTRATOR_DAILY_OUTPUT_TOKENS),
        };
    }

    /** Refuses a ceiling below the minimum before writing either value, so a refusal changes nothing. */
    async set({ enabled, dailyOutputTokens }: SetOrchestratorSettingRequest): Promise<OrchestratorSetting> {
        if (dailyOutputTokens !== undefined && dailyOutputTokens < ORCHESTRATOR_CEILING_MINIMUM) {
            throw httpError(400).withDetails({ reason: `the daily ceiling must be at least ${ORCHESTRATOR_CEILING_MINIMUM} output tokens` });
        }
        if (enabled !== undefined) await this.settings.set(ORCHESTRATOR_ENABLED, enabled);
        if (dailyOutputTokens !== undefined) await this.settings.set(ORCHESTRATOR_DAILY_OUTPUT_TOKENS, dailyOutputTokens);
        return this.get();
    }
}
