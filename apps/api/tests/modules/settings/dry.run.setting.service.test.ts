import { describe, expect, it, vi } from 'vitest';
import { DryRunSettingService } from '#modules/settings/dry.run.setting.service.js';
import { DRY_RUN_ENABLED } from '#modules/settings/dry.run.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

/**
 * A `SettingsStore` fake that actually remembers a write, the same idiom
 * `claude.config.dir.setting.service.test.ts` uses — `DryRunSettingService.set` both persists and
 * echoes back through the same value, so a fake that only stubbed `get` in isolation from `set`
 * would not catch a write that silently failed to update what a following `get` observes.
 */
const fakeSettings = (initial: boolean): { store: SettingsStore; set: ReturnType<typeof vi.fn> } => {
    let value = initial;
    const set = vi.fn(async (_definition: unknown, next: boolean) => {
        value = next;
    });
    const store = { get: vi.fn(async () => value), set } as unknown as SettingsStore;
    return { store, set };
};

describe('DryRunSettingService.get', () => {
    it('reports whatever the store currently resolves for DRY_RUN_ENABLED', async () => {
        const { store } = fakeSettings(true);
        const service = new DryRunSettingService(store);

        await expect(service.get()).resolves.toEqual({ enabled: true });
    });

    it('reports false the same way, without special-casing the default', async () => {
        const { store } = fakeSettings(false);
        const service = new DryRunSettingService(store);

        await expect(service.get()).resolves.toEqual({ enabled: false });
    });
});

describe('DryRunSettingService.set', () => {
    it('persists the new value through SettingsStore keyed by DRY_RUN_ENABLED, then echoes it back', async () => {
        const { store, set } = fakeSettings(true);
        const service = new DryRunSettingService(store);

        const result = await service.set({ enabled: false });

        expect(set).toHaveBeenCalledWith(DRY_RUN_ENABLED, false);
        expect(result).toEqual({ enabled: false });
    });

    it('a write is read back by a following get', async () => {
        const { store } = fakeSettings(true);
        const service = new DryRunSettingService(store);

        await service.set({ enabled: false });

        await expect(service.get()).resolves.toEqual({ enabled: false });
    });
});
