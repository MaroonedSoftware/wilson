import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { EventLog } from '#modules/events/event.log.js';
import { PlanDraftJob } from '#modules/jobs/plan.draft.job.js';
import type { PlanService } from '#modules/plan/plan.service.js';
import { AUTO_SPLIT_ENABLED } from '#modules/settings/auto.split.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };

describe('PlanDraftJob', () => {
    let plans: { autoDraft: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn>; outputTokensSince: ReturnType<typeof vi.fn> };
    let enabled: boolean;
    let ceiling: number;

    const run = () => {
        const settings = { get: vi.fn(async (setting: { key: string }) => (setting.key === AUTO_SPLIT_ENABLED.key ? enabled : ceiling)) };
        return new PlanDraftJob(
            plans as unknown as PlanService,
            new StaticBoardConfig('test', '/tmp/code', '/tmp/wt', '/tmp/run'),
            {} as BoardRepository,
            events as unknown as EventLog,
            settings as unknown as SettingsStore,
            logger as never,
        ).run({ cardId: '0002', project: 'test' });
    };

    const recorded = () => events.append.mock.calls.map(([event]) => ({ type: event.type, reason: event.payload.reason }));

    beforeEach(() => {
        plans = { autoDraft: vi.fn(async () => undefined) };
        events = { append: vi.fn(async () => {}), outputTokensSince: vi.fn(async () => 0) };
        enabled = true;
        ceiling = 0;
    });

    it('drafts the piece and records it', async () => {
        await run();

        expect(plans.autoDraft).toHaveBeenCalledWith('0002');
        expect(recorded()).toEqual([{ type: 'card.plan-drafted', reason: undefined }]);
    });

    it('records why autoDraft declined', async () => {
        plans.autoDraft.mockResolvedValue('0002 already has a planning conversation');

        await run();

        expect(recorded()).toEqual([{ type: 'card.plan-draft-skipped', reason: '0002 already has a planning conversation' }]);
    });

    it('records a refused draft by its reason and does not fail the job', async () => {
        plans.autoDraft.mockRejectedValue(Object.assign(new Error('Bad Request'), { details: { reason: 'draft is incomplete' } }));

        await expect(run()).resolves.toBeUndefined();

        expect(recorded()).toEqual([{ type: 'card.plan-draft-skipped', reason: 'draft is incomplete' }]);
    });

    it('does not draft once the setting has been turned off', async () => {
        enabled = false;

        await run();

        expect(plans.autoDraft).not.toHaveBeenCalled();
        expect(recorded()[0]?.reason).toBe('auto-split was turned off');
    });

    it('does not draft at the daily ceiling', async () => {
        ceiling = 100;
        events.outputTokensSince.mockResolvedValue(100);

        await run();

        expect(plans.autoDraft).not.toHaveBeenCalled();
        expect(recorded()[0]?.reason).toContain('daily ceiling of 100');
    });
});
