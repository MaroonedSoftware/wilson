import { describe, expect, it, vi } from 'vitest';
import { AutoSplitSettingService } from '#modules/settings/auto.split.setting.service.js';
import { AUTO_SPLIT_ENABLED } from '#modules/settings/auto.split.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

const fakeSettings = (initial: boolean) => {
    let value = initial;
    const set = vi.fn(async (_definition: unknown, next: boolean) => {
        value = next;
    });
    return { store: { get: vi.fn(async () => value), set } as unknown as SettingsStore, set };
};

describe('AutoSplitSettingService', () => {
    it('reports what the store resolves', async () => {
        await expect(new AutoSplitSettingService(fakeSettings(false).store).get()).resolves.toEqual({ enabled: false });
    });

    it('persists through the store keyed by AUTO_SPLIT_ENABLED, and a following read sees it', async () => {
        const { store, set } = fakeSettings(false);
        const service = new AutoSplitSettingService(store);

        await expect(service.set({ enabled: true })).resolves.toEqual({ enabled: true });

        expect(set).toHaveBeenCalledWith(AUTO_SPLIT_ENABLED, true);
        await expect(service.get()).resolves.toEqual({ enabled: true });
    });
});
