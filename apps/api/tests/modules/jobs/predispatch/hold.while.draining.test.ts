import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import { CardStageJob } from '#modules/jobs/card.stage.job.js';
import { DRAIN_HOLD, holdWhileDraining } from '#modules/jobs/predispatch/hold.while.draining.js';
import type { PreDispatchDeps } from '#modules/jobs/predispatch/predispatch.check.js';
import { DRAIN_ENABLED } from '#modules/settings/drain.enabled.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import type { StageDispatcher } from '#modules/stages/stage.dispatcher.js';

const stageConfigs = new StaticStageConfigStore(`
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: merged
    onFail: implementing
`);

describe('holdWhileDraining', () => {
    const board = new StaticBoardConfig('demo', '/nowhere/code', '/nowhere/worktrees', '/nowhere/run');
    let settings: { get: ReturnType<typeof vi.fn> };
    let broker: { send: ReturnType<typeof vi.fn> };
    let cardJobs: { record: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn>; tail: ReturnType<typeof vi.fn> };
    let deps: PreDispatchDeps;

    beforeEach(() => {
        settings = { get: vi.fn().mockResolvedValue(true) };
        broker = { send: vi.fn().mockResolvedValue('held-job') };
        cardJobs = { record: vi.fn().mockResolvedValue(undefined), clear: vi.fn().mockResolvedValue(undefined) };
        events = { append: vi.fn().mockResolvedValue(undefined), tail: vi.fn().mockResolvedValue([]) };
        deps = {
            board,
            boardRepo: {} as BoardRepository,
            events: events as unknown as EventLog,
            cardJobs: cardJobs as unknown as CardJobs,
            stageConfigs,
            broker: broker as unknown as JobBroker,
            settings: settings as unknown as SettingsStore,
        };
    });

    it('does nothing when the server is not draining', async () => {
        settings.get.mockResolvedValue(false);

        expect(await holdWhileDraining(deps, '0001', 'implementing')).toBe(false);
        expect(settings.get).toHaveBeenCalledWith(DRAIN_ENABLED);
        expect(broker.send).not.toHaveBeenCalled();
    });

    it('re-sends the job for later and hands the claim to it', async () => {
        expect(await holdWhileDraining(deps, '0001', 'implementing')).toBe(true);

        expect(broker.send).toHaveBeenCalledWith(
            'card.stage',
            { cardId: '0001', stageName: 'implementing', project: board.project },
            { startAfter: DRAIN_HOLD },
        );
        expect(cardJobs.record).toHaveBeenCalledWith('0001', 'held-job');
        expect(cardJobs.clear).not.toHaveBeenCalled();
    });

    it('records a hold once, not on every wake-up', async () => {
        await holdWhileDraining(deps, '0001', 'implementing');
        expect(events.append).toHaveBeenCalledTimes(1);
        expect(events.append.mock.calls[0]![0]).toMatchObject({ type: 'dispatch.deferred', payload: { held: true } });

        events.tail.mockResolvedValue([{ type: 'dispatch.deferred', payload: { held: true } }]);
        await holdWhileDraining(deps, '0001', 'implementing');
        expect(events.append).toHaveBeenCalledTimes(1);
    });

    it('still records a hold after a different deferral', async () => {
        events.tail.mockResolvedValue([{ type: 'dispatch.deferred', payload: { reason: 'scope conflict' } }]);

        await holdWhileDraining(deps, '0001', 'implementing');

        expect(events.append).toHaveBeenCalledTimes(1);
    });

    it('lets the dispatch proceed when the setting cannot be read', async () => {
        settings.get.mockRejectedValue(new Error('database down'));

        expect(await holdWhileDraining(deps, '0001', 'implementing')).toBe(false);
    });

    it('throws when the job cannot be re-sent, so the queue retries it and the card is not lost', async () => {
        broker.send.mockRejectedValue(new Error('connection closed'));

        await expect(holdWhileDraining(deps, '0001', 'implementing')).rejects.toThrow('connection closed');
        expect(cardJobs.record).not.toHaveBeenCalled();
    });

    it('keeps a chained or started job from reaching the dispatcher', async () => {
        const dispatcher = { run: vi.fn() };
        const job = new CardStageJob(
            dispatcher as unknown as StageDispatcher,
            broker as unknown as JobBroker,
            board,
            {} as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
            stageConfigs,
            settings as unknown as SettingsStore,
        );

        await job.run({ cardId: '0001', stageName: 'implementing', project: board.project });

        expect(dispatcher.run).not.toHaveBeenCalled();
        expect(cardJobs.record).toHaveBeenCalledWith('0001', 'held-job');
    });
});
