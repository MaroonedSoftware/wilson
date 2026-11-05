import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_DAILY_OUTPUT_TOKENS, ORCHESTRATOR_ENABLED } from '#modules/settings/orchestrator.setting.js';
import { OrchestratorSettingService } from '#modules/settings/orchestrator.setting.service.js';
import type { SettingDefinition } from '#modules/settings/setting.definition.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

const store = () => {
    const values = new Map<string, unknown>();
    return {
        values,
        settings: {
            get: async <T>(definition: SettingDefinition<T>) =>
                values.has(definition.key) ? (values.get(definition.key) as T) : definition.defaultValue,
            set: async <T>(definition: SettingDefinition<T>, value: T) => void values.set(definition.key, value),
        } as unknown as SettingsStore,
    };
};

describe('the orchestrator settings', () => {
    it('are off by default, with a ceiling', async () => {
        const service = new OrchestratorSettingService(store().settings);

        expect(await service.get()).toEqual({ enabled: false, dailyOutputTokens: 100_000 });
    });

    it('change only what they are given', async () => {
        const { settings, values } = store();
        const service = new OrchestratorSettingService(settings);

        expect(await service.set({ enabled: true })).toEqual({ enabled: true, dailyOutputTokens: 100_000 });
        expect(await service.set({ dailyOutputTokens: 5_000 })).toEqual({ enabled: true, dailyOutputTokens: 5_000 });
        expect([...values.keys()].sort()).toEqual([ORCHESTRATOR_DAILY_OUTPUT_TOKENS.key, ORCHESTRATOR_ENABLED.key].sort());
    });

    it('refuse a ceiling too low to mean anything, and change nothing when they do', async () => {
        const { settings, values } = store();
        const service = new OrchestratorSettingService(settings);

        await expect(service.set({ enabled: true, dailyOutputTokens: 0 })).rejects.toMatchObject({ statusCode: 400 });
        expect(values.size).toBe(0);
    });

    it('fail fast on a bad environment value rather than running without a ceiling', () => {
        expect(() => ORCHESTRATOR_DAILY_OUTPUT_TOKENS.parseEnv('0')).toThrow('at least');
        expect(() => ORCHESTRATOR_DAILY_OUTPUT_TOKENS.parseEnv('lots')).toThrow('at least');
        expect(ORCHESTRATOR_DAILY_OUTPUT_TOKENS.parseEnv('5000')).toBe(5_000);
        expect(ORCHESTRATOR_ENABLED.parseEnv('TRUE')).toBe(true);
        expect(ORCHESTRATOR_ENABLED.parseEnv('no')).toBe(false);
    });
});
