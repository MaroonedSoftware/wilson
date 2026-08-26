import { describe, expect, it, vi } from 'vitest';
import type { JobRunner } from '@maroonedsoftware/jobbroker';

/**
 * Card 0106. `node:timers/promises` is mocked the same way `shutdown.faketimer.test.ts` mocks it:
 * `stopCardStageJobs` (called from `BoundedCardStageJobRunner.stop()`) races `runner.stop()` against
 * a real 35s `delay(SHUTDOWN_DEADLINE_MS)` — every fake `inner.stop()` below resolves immediately, so
 * that race is never actually decided by the timer, but leaving the real `setTimeout` unmocked would
 * still schedule a genuine 35s timer in the background of every test in this file.
 */
const delayMock = vi.fn(async () => undefined);
vi.mock('node:timers/promises', () => ({ setTimeout: delayMock }));

const { AbandonedCardJobsError, BoundedCardStageJobRunner } = await import('#modules/jobs/jobs.module.js');
const { RunningCards } = await import('#modules/jobs/running.cards.js');

type FakeCardJobs = { confirmInFlightAfterStop: ReturnType<typeof vi.fn> };
const fakeCardJobs = (outcomes: Record<string, string | undefined> = {}): FakeCardJobs => ({
    confirmInFlightAfterStop: vi.fn(async (cardId: string) => outcomes[cardId]),
});

const fakeInnerRunner = (order?: string[]): JobRunner =>
    ({
        start: vi.fn(async () => {
            order?.push('inner.start');
        }),
        stop: vi.fn(async () => {
            order?.push('inner.stop');
        }),
    }) as unknown as JobRunner;

const fakePoller = (order?: string[]) =>
    ({
        stop: vi.fn(async () => {
            order?.push('poller.stop');
        }),
    }) as unknown as import('#modules/jobs/poller.js').Poller;

const fakePollerSettings = (order?: string[]) =>
    ({
        applyCurrentValue: vi.fn(async () => {
            order?.push('pollerSettings.applyCurrentValue');
        }),
    }) as unknown as import('#modules/settings/poller.setting.service.js').PollerSettingService;

/**
 * `BoundedCardStageJobRunner` is exported now (card 0106), specifically so a test can construct one
 * directly against fakes — the comment on the class in `jobs.module.ts` says so explicitly.
 */
describe('BoundedCardStageJobRunner.start', () => {
    it('applies the current poller setting before starting the inner runner', async () => {
        const order: string[] = [];
        const inner = fakeInnerRunner(order);
        const pollerSettings = fakePollerSettings(order);
        const runner = new BoundedCardStageJobRunner(inner, new RunningCards(), fakeCardJobs() as never, fakePoller(), pollerSettings);

        await runner.start();

        expect(order).toEqual(['pollerSettings.applyCurrentValue', 'inner.start']);
    });

    /**
     * This is what makes a database row already in place at boot take effect the same way a write
     * made after boot does: `start()` has to actually wait for the answer, not just kick it off.
     */
    it('awaits the poller setting application — a failure there stops the inner runner from starting at all', async () => {
        const inner = fakeInnerRunner();
        const pollerSettings = {
            applyCurrentValue: vi.fn(async () => {
                throw new Error('settings table unreachable');
            }),
        } as unknown as import('#modules/settings/poller.setting.service.js').PollerSettingService;
        const runner = new BoundedCardStageJobRunner(inner, new RunningCards(), fakeCardJobs() as never, fakePoller(), pollerSettings);

        await expect(runner.start()).rejects.toThrow('settings table unreachable');
        expect(inner.start).not.toHaveBeenCalled();
    });
});

describe('BoundedCardStageJobRunner.stop', () => {
    it('stops the poller before computing the shutdown report', async () => {
        const order: string[] = [];
        const inner = fakeInnerRunner(order);
        const poller = fakePoller(order);
        const runner = new BoundedCardStageJobRunner(inner, new RunningCards(), fakeCardJobs() as never, poller, fakePollerSettings());

        await runner.stop();

        expect(order).toEqual(['poller.stop', 'inner.stop']);
    });

    /**
     * Before this card, `poller?.stop()` was conditional on a `Poller` even existing (off by
     * default meant `poller` was `undefined`). It is registered and constructed unconditionally
     * now, and `stop()` calls it unconditionally too — this proves that, rather than merely
     * asserting the field is non-optional at the type level.
     */
    it('always stops the poller, unconditionally — not only when something is running', async () => {
        const inner = fakeInnerRunner();
        const poller = fakePoller();
        const runner = new BoundedCardStageJobRunner(inner, new RunningCards(), fakeCardJobs() as never, poller, fakePollerSettings());

        await runner.stop();

        expect(poller.stop).toHaveBeenCalledTimes(1);
    });

    /**
     * Acceptance criterion: "Setting it to false stops the timer; a stage already running is
     * unaffected." At this class's boundary that means the shutdown report is entirely a function
     * of `RunningCards`/`CardJobs` — a card the queue is still carrying is reported abandoned
     * exactly as before this card, whether or not `poller.stop()` itself resolved cleanly.
     */
    it('reports a card RunningCards still shows as abandoned, regardless of the poller having stopped cleanly', async () => {
        const inner = fakeInnerRunner();
        const poller = fakePoller();
        const running = new RunningCards();
        running.add('0099');
        const cardJobs = fakeCardJobs({ '0099': 'job-77' });
        const runner = new BoundedCardStageJobRunner(inner, running, cardJobs as never, poller, fakePollerSettings());

        await expect(runner.stop()).rejects.toThrow(AbandonedCardJobsError);
        expect(poller.stop).toHaveBeenCalledTimes(1);
        expect(cardJobs.confirmInFlightAfterStop).toHaveBeenCalledWith('0099');
    });

    it('resolves cleanly when nothing was abandoned', async () => {
        const inner = fakeInnerRunner();
        const runner = new BoundedCardStageJobRunner(inner, new RunningCards(), fakeCardJobs() as never, fakePoller(), fakePollerSettings());

        await expect(runner.stop()).resolves.toBeUndefined();
    });
});
