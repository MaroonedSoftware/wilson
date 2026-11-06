import { describe, expect, it, vi } from 'vitest';
import { AutoPlanSettingService } from '#modules/settings/auto.plan.setting.service.js';
import { AUTO_PLAN_ENABLED } from '#modules/settings/auto.plan.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

const fakeSettings = (initial: boolean) => {
    let value = initial;
    const set = vi.fn(async (_definition: unknown, next: boolean) => {
        value = next;
    });
    return { store: { get: vi.fn(async () => value), set } as unknown as SettingsStore, set };
};

describe('AutoPlanSettingService', () => {
    it('reports what the store resolves', async () => {
        await expect(new AutoPlanSettingService(fakeSettings(false).store).get()).resolves.toEqual({ enabled: false });
    });

    it('persists through the store keyed by AUTO_PLAN_ENABLED, and a following read sees it', async () => {
        const { store, set } = fakeSettings(false);
        const service = new AutoPlanSettingService(store);

        await expect(service.set({ enabled: true })).resolves.toEqual({ enabled: true });

        expect(set).toHaveBeenCalledWith(AUTO_PLAN_ENABLED, true);
        await expect(service.get()).resolves.toEqual({ enabled: true });
    });
});
