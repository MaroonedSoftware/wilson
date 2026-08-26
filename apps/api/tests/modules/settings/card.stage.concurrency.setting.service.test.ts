import { describe, expect, it, vi } from 'vitest';
import { CardStageConcurrencySettingService } from '#modules/settings/card.stage.concurrency.setting.service.js';
import { CARD_STAGE_CONCURRENCY } from '#modules/settings/card.stage.concurrency.setting.js';
import { CARD_STAGE_CONCURRENCY_MAX, CARD_STAGE_CONCURRENCY_MIN } from '#modules/jobs/job.runner.config.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

/**
 * A `SettingsStore` fake that actually remembers a write, the same way `poller.setting.service.test
 * .ts`'s does — `CardStageConcurrencySettingService.set` both persists and echoes back through the
 * same value, so a fake that only stubbed `get` in isolation from `set` would not catch a write
 * that silently failed to update what a following `get` observes.
 */
const fakeSettings = (initial: number): { store: SettingsStore; set: ReturnType<typeof vi.fn> } => {
    let value = initial;
    const set = vi.fn(async (_definition: unknown, next: number) => {
        value = next;
    });
    const store = { get: vi.fn(async () => value), set } as unknown as SettingsStore;
    return { store, set };
};

describe('CardStageConcurrencySettingService.get', () => {
    it('wraps the resolved setting as { concurrency }', async () => {
        const { store } = fakeSettings(5);
        const service = new CardStageConcurrencySettingService(store);

        await expect(service.get()).resolves.toEqual({ concurrency: 5 });
    });
});

/**
 * Constraint: "Bounds belong on the server ... The API refuses an out-of-range value with a
 * sentence." Note what this service deliberately does *not* do, unlike `PollerIntervalSettingService
 * .set` or `PollerSettingService.set`: nothing here reaches into the running process — see
 * `CardStageConcurrencySettingService`'s own doc and `BoundedCardStageJobRunner` (jobs.module.ts)
 * for why a write here cannot be pushed into a running pg-boss worker. `set` only validates and
 * persists.
 */
describe('CardStageConcurrencySettingService.set', () => {
    it('persists an in-range value through SettingsStore keyed by CARD_STAGE_CONCURRENCY, then echoes it back', async () => {
        const { store, set } = fakeSettings(3);
        const service = new CardStageConcurrencySettingService(store);

        const result = await service.set({ concurrency: 5 });

        expect(set).toHaveBeenCalledWith(CARD_STAGE_CONCURRENCY, 5);
        expect(result).toEqual({ concurrency: 5 });
    });

    it.each([[CARD_STAGE_CONCURRENCY_MIN - 1], [0], [-1]])(
        'refuses %d, below the floor, with a 400 naming both bounds in a sentence, and writes nothing',
        async raw => {
            const { store, set } = fakeSettings(3);
            const service = new CardStageConcurrencySettingService(store);

            await expect(service.set({ concurrency: raw })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining(`between ${CARD_STAGE_CONCURRENCY_MIN} and ${CARD_STAGE_CONCURRENCY_MAX}`) },
            });
            expect(set).not.toHaveBeenCalled();
        },
    );

    it(`refuses ${CARD_STAGE_CONCURRENCY_MAX + 1}, above the ceiling, the same way`, async () => {
        const { store, set } = fakeSettings(3);
        const service = new CardStageConcurrencySettingService(store);

        await expect(service.set({ concurrency: CARD_STAGE_CONCURRENCY_MAX + 1 })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining(`between ${CARD_STAGE_CONCURRENCY_MIN} and ${CARD_STAGE_CONCURRENCY_MAX}`) },
        });
        expect(set).not.toHaveBeenCalled();
    });

    it.each([[CARD_STAGE_CONCURRENCY_MIN], [CARD_STAGE_CONCURRENCY_MAX]])(
        'accepts the boundary value %d itself, not just values strictly inside the range',
        async boundary => {
            const { store, set } = fakeSettings(3);
            const service = new CardStageConcurrencySettingService(store);

            await expect(service.set({ concurrency: boundary })).resolves.toEqual({ concurrency: boundary });
            expect(set).toHaveBeenCalledWith(CARD_STAGE_CONCURRENCY, boundary);
        },
    );

    it('leaves the previously persisted value untouched when the write is refused', async () => {
        const { store, set } = fakeSettings(3);
        const service = new CardStageConcurrencySettingService(store);

        await expect(service.set({ concurrency: CARD_STAGE_CONCURRENCY_MAX + 1 })).rejects.toMatchObject({ statusCode: 400 });
        expect(set).not.toHaveBeenCalled();
        await expect(service.get()).resolves.toEqual({ concurrency: 3 });
    });
});
