import { describe, expect, it, vi } from 'vitest';
import { PollerIntervalSettingService } from '#modules/settings/poller.interval.setting.service.js';
import { POLLER_INTERVAL_MS } from '#modules/settings/poller.interval.setting.js';
import { POLLER_INTERVAL_MS_MAX, POLLER_INTERVAL_MS_MIN } from '#modules/jobs/job.runner.config.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

/**
 * A `SettingsStore` fake that actually remembers a write, the same way `poller.setting.service.test
 * .ts`'s does — `PollerIntervalSettingService.set` both persists and echoes back through the same
 * value, so a fake that only stubbed `get` in isolation from `set` would not catch a write that
 * silently failed to update what a following `get` observes.
 */
const fakeSettings = (initial: number): { store: SettingsStore; set: ReturnType<typeof vi.fn> } => {
    let value = initial;
    const set = vi.fn(async (_definition: unknown, next: number) => {
        value = next;
    });
    const store = { get: vi.fn(async () => value), set } as unknown as SettingsStore;
    return { store, set };
};

describe('PollerIntervalSettingService.get', () => {
    it('wraps the resolved setting as { intervalMs }', async () => {
        const { store } = fakeSettings(45_000);
        const service = new PollerIntervalSettingService(store);

        await expect(service.get()).resolves.toEqual({ intervalMs: 45_000 });
    });
});

/**
 * Constraint: "Bounds belong on the server ... The API refuses an out-of-range value with a
 * sentence." `curl` and the settings page both go through `set`, so this is where that refusal has
 * to live and where a test can prove it without a browser at all.
 */
describe('PollerIntervalSettingService.set', () => {
    it('persists an in-range value through SettingsStore keyed by POLLER_INTERVAL_MS, then echoes it back', async () => {
        const { store, set } = fakeSettings(30_000);
        const service = new PollerIntervalSettingService(store);

        const result = await service.set({ intervalMs: 60_000 });

        expect(set).toHaveBeenCalledWith(POLLER_INTERVAL_MS, 60_000);
        expect(result).toEqual({ intervalMs: 60_000 });
    });

    it.each([[POLLER_INTERVAL_MS_MIN - 1], [0], [-1]])(
        'refuses %d, below the floor, with a 400 naming both bounds in a sentence, and writes nothing',
        async raw => {
            const { store, set } = fakeSettings(30_000);
            const service = new PollerIntervalSettingService(store);

            await expect(service.set({ intervalMs: raw })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining(`between ${POLLER_INTERVAL_MS_MIN} and ${POLLER_INTERVAL_MS_MAX}`) },
            });
            expect(set).not.toHaveBeenCalled();
        },
    );

    it(`refuses ${POLLER_INTERVAL_MS_MAX + 1}, above the ceiling, the same way`, async () => {
        const { store, set } = fakeSettings(30_000);
        const service = new PollerIntervalSettingService(store);

        await expect(service.set({ intervalMs: POLLER_INTERVAL_MS_MAX + 1 })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining(`between ${POLLER_INTERVAL_MS_MIN} and ${POLLER_INTERVAL_MS_MAX}`) },
        });
        expect(set).not.toHaveBeenCalled();
    });

    it.each([[POLLER_INTERVAL_MS_MIN], [POLLER_INTERVAL_MS_MAX]])(
        'accepts the boundary value %d itself, not just values strictly inside the range',
        async boundary => {
            const { store, set } = fakeSettings(30_000);
            const service = new PollerIntervalSettingService(store);

            await expect(service.set({ intervalMs: boundary })).resolves.toEqual({ intervalMs: boundary });
            expect(set).toHaveBeenCalledWith(POLLER_INTERVAL_MS, boundary);
        },
    );

    it('leaves the previously persisted value untouched when the write is refused', async () => {
        const { store, set } = fakeSettings(30_000);
        const service = new PollerIntervalSettingService(store);

        await expect(service.set({ intervalMs: POLLER_INTERVAL_MS_MAX + 1 })).rejects.toMatchObject({ statusCode: 400 });
        expect(set).not.toHaveBeenCalled();
        await expect(service.get()).resolves.toEqual({ intervalMs: 30_000 });
    });
});
