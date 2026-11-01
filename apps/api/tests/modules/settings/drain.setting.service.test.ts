import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import { RunningCards } from '#modules/jobs/running.cards.js';
import { DRAIN_ENABLED } from '#modules/settings/drain.enabled.setting.js';
import { DrainSettingService } from '#modules/settings/drain.setting.service.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

describe('DrainSettingService', () => {
    let draining: boolean;
    let running: RunningCards;
    let cardJobs: { drainCounts: ReturnType<typeof vi.fn> };
    let settings: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
    let service: DrainSettingService;

    beforeEach(() => {
        draining = true;
        running = new RunningCards();
        cardJobs = { drainCounts: vi.fn().mockResolvedValue({ held: 2, planDrafts: 0 }) };
        settings = {
            get: vi.fn(async () => draining),
            set: vi.fn(async (_definition: unknown, value: boolean) => {
                draining = value;
            }),
        };
        service = new DrainSettingService(settings as unknown as SettingsStore, running, cardJobs as unknown as CardJobs);
    });

    it('is safe to restart once draining with nothing running', async () => {
        expect(await service.get()).toEqual({ draining: true, running: [], held: 2, planDrafts: 0, safeToRestart: true });
    });

    it('is not safe while a stage runs, and names it', async () => {
        running.add('demo', '0001');

        expect(await service.get()).toMatchObject({ running: [{ project: 'demo', cardId: '0001' }], safeToRestart: false });
    });

    it('is not safe while a plan draft runs', async () => {
        cardJobs.drainCounts.mockResolvedValue({ held: 0, planDrafts: 1 });

        expect(await service.get()).toMatchObject({ planDrafts: 1, safeToRestart: false });
    });

    it('is not safe when idle but not draining, because the next stage can start at any moment', async () => {
        draining = false;

        expect(await service.get()).toMatchObject({ draining: false, safeToRestart: false });
    });

    it('persists a write and answers with the new status', async () => {
        expect(await service.set({ draining: false })).toMatchObject({ draining: false });
        expect(settings.set).toHaveBeenCalledWith(DRAIN_ENABLED, false);
    });
});
