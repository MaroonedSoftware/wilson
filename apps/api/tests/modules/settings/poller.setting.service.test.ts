import { describe, expect, it, vi } from 'vitest';
import { PollerSettingService } from '#modules/settings/poller.setting.service.js';
import { POLLER_ENABLED } from '#modules/settings/poller.enabled.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import type { Poller } from '#modules/jobs/poller.js';

/**
 * A `SettingsStore` fake that actually remembers a write, the same way `statefulCardJobs` does in
 * `poller.test.ts` — `PollerSettingService.set` both persists and reads back through the same
 * object, so a fake that only stubs `get` in isolation from `set` would not catch `set` failing to
 * update what a following `get`/`applyCurrentValue` observes.
 */
const fakeSettings = (initial: boolean): { store: SettingsStore; set: ReturnType<typeof vi.fn> } => {
    let value = initial;
    const set = vi.fn(async (_definition: unknown, next: boolean) => {
        value = next;
    });
    const store = { get: vi.fn(async () => value), set } as unknown as SettingsStore;
    return { store, set };
};

const fakePoller = (): { poller: Poller; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } => {
    const start = vi.fn();
    const stop = vi.fn(async () => {});
    return { poller: { start, stop } as unknown as Poller, start, stop };
};

describe('PollerSettingService.get', () => {
    it('wraps the resolved setting as { enabled }', async () => {
        const { store } = fakeSettings(true);
        const { poller } = fakePoller();
        const service = new PollerSettingService(store, poller);

        await expect(service.get()).resolves.toEqual({ enabled: true });
    });

    it('reflects false just as faithfully as true', async () => {
        const { store } = fakeSettings(false);
        const { poller } = fakePoller();
        const service = new PollerSettingService(store, poller);

        await expect(service.get()).resolves.toEqual({ enabled: false });
    });
});

/**
 * `applyCurrentValue` is the one place that turns "what the setting resolves to" into "is the
 * poller actually running" — called both from `set` below and, unconditionally, from
 * `BoundedCardStageJobRunner.start()` (`jobs.module.ts`) so a database row already in place at boot
 * takes effect exactly like a write made afterwards.
 */
describe('PollerSettingService.applyCurrentValue', () => {
    it('starts the poller when the setting currently resolves true, and never calls stop', async () => {
        const { store } = fakeSettings(true);
        const { poller, start, stop } = fakePoller();
        const service = new PollerSettingService(store, poller);

        const result = await service.applyCurrentValue();

        expect(start).toHaveBeenCalledTimes(1);
        expect(stop).not.toHaveBeenCalled();
        expect(result).toEqual({ enabled: true });
    });

    it('stops the poller when the setting currently resolves false, and never calls start', async () => {
        const { store } = fakeSettings(false);
        const { poller, start, stop } = fakePoller();
        const service = new PollerSettingService(store, poller);

        const result = await service.applyCurrentValue();

        expect(stop).toHaveBeenCalledTimes(1);
        expect(start).not.toHaveBeenCalled();
        expect(result).toEqual({ enabled: false });
    });
});

describe('PollerSettingService.set', () => {
    it('persists the write through SettingsStore keyed by POLLER_ENABLED, then applies it', async () => {
        const { store, set } = fakeSettings(false);
        const { poller, start } = fakePoller();
        const service = new PollerSettingService(store, poller);

        const result = await service.set({ enabled: true });

        expect(set).toHaveBeenCalledWith(POLLER_ENABLED, true);
        expect(start).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ enabled: true });
    });

    it('stops the poller immediately when the write turns it off', async () => {
        const { store, set } = fakeSettings(true);
        const { poller, stop } = fakePoller();
        const service = new PollerSettingService(store, poller);

        const result = await service.set({ enabled: false });

        expect(set).toHaveBeenCalledWith(POLLER_ENABLED, false);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ enabled: false });
    });

    it('writes before applying — the persisted value, not the pre-write one, is what gets applied', async () => {
        const order: string[] = [];
        const store = {
            get: vi.fn(async () => {
                order.push('get');
                return true;
            }),
            set: vi.fn(async () => {
                order.push('set');
            }),
        } as unknown as SettingsStore;
        const poller = { start: vi.fn(() => order.push('start')), stop: vi.fn(async () => {}) } as unknown as Poller;
        const service = new PollerSettingService(store, poller);

        await service.set({ enabled: true });

        expect(order).toEqual(['set', 'get', 'start']);
    });
});
