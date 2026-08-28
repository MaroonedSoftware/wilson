import { describe, expect, it, vi } from 'vitest';
import type { JobRunner } from '@maroonedsoftware/jobbroker';

/**
 * Card 0106. `node:timers/promises` is mocked the same way `shutdown.faketimer.test.ts` mocks it:
 * `stopCardStageJobs` (called from `BoundedCardStageJobRunner.stop()`) races `runner.stop()` against
 * a real 35s `delay(SHUTDOWN_DEADLINE_MS)` — every fake `inner.stop()` below resolves immediately, so
 * that race is never actually decided by the timer, but leaving the real `setTimeout` unmocked would
 * still schedule a genuine 35s timer in the background of every test in this file.
 *
 * Card 0115's `startConcurrencyWatcher`/`watchConcurrency` also call this same `delay` on its own
 * loop, resolving instantly here too — a `start()` test that never calls `stop()` afterwards would
 * otherwise leave that loop spinning in the background for the rest of the suite, so every test below
 * that calls `start()` also calls `stop()` before it ends.
 */
const delayMock = vi.fn(async () => undefined);
vi.mock('node:timers/promises', () => ({ setTimeout: delayMock }));

const { AbandonedCardJobsError, BoundedCardStageJobRunner, CARD_STAGE_WORKER } = await import('#modules/jobs/jobs.module.js');
const { RunningCards } = await import('#modules/jobs/running.cards.js');
const { CARD_STAGE_CONCURRENCY } = await import('#modules/settings/card.stage.concurrency.setting.js');

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
 * A `SettingsStore` fake for the two settings `BoundedCardStageJobRunner` reads
 * (`CARD_STAGE_CONCURRENCY`, `POLLER_INTERVAL_MS`, card 0115): resolves each to its own coded
 * default, keyed by `key` so the two never collide.
 */
const fakeSettings = (): import('#modules/settings/settings.store.js').SettingsStore =>
    ({
        get: vi.fn(async (definition: { defaultValue: unknown }) => definition.defaultValue),
        set: vi.fn(async () => undefined),
    }) as unknown as import('#modules/settings/settings.store.js').SettingsStore;

const fakeLogger = (): import('@maroonedsoftware/logger').Logger =>
    ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as import('@maroonedsoftware/logger').Logger;

/**
 * A `SettingsStore` fake keyed by `overrides`, falling back to each definition's own coded default
 * otherwise — lets a test pin `CARD_STAGE_CONCURRENCY` to a specific "desired" value while
 * `POLLER_INTERVAL_MS` (also read by this class, for the watcher's own cadence) still resolves to
 * something sane.
 */
const fakeSettingsFor = (overrides: Record<string, unknown>): import('#modules/settings/settings.store.js').SettingsStore =>
    ({
        get: vi.fn(async (definition: { key: string; defaultValue: unknown }) =>
            Object.prototype.hasOwnProperty.call(overrides, definition.key) ? overrides[definition.key] : definition.defaultValue,
        ),
        set: vi.fn(async () => undefined),
    }) as unknown as import('#modules/settings/settings.store.js').SettingsStore;

/**
 * `BoundedCardStageJobRunner` is exported now (card 0106), specifically so a test can construct one
 * directly against fakes — the comment on the class in `jobs.module.ts` says so explicitly.
 */
describe('BoundedCardStageJobRunner.start', () => {
    it('applies the current poller setting before starting the inner runner', async () => {
        const order: string[] = [];
        const inner = fakeInnerRunner(order);
        const pollerSettings = fakePollerSettings(order);
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            fakeCardJobs() as never,
            fakePoller(),
            pollerSettings,
            fakeSettings(),
            fakeLogger(),
        );

        await runner.start();

        expect(order).toEqual(['pollerSettings.applyCurrentValue', 'inner.start']);

        // start() also kicks off card 0115's concurrency-watcher loop in the background — stop it
        // here so it does not keep spinning (on the mocked, instantly-resolving delay) after this
        // test ends. See the file-level comment on `delayMock`.
        await runner.stop();
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
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            fakeCardJobs() as never,
            fakePoller(),
            pollerSettings,
            fakeSettings(),
            fakeLogger(),
        );

        await expect(runner.start()).rejects.toThrow('settings table unreachable');
        expect(inner.start).not.toHaveBeenCalled();
    });
});

describe('BoundedCardStageJobRunner.stop', () => {
    it('stops the poller before computing the shutdown report', async () => {
        const order: string[] = [];
        const inner = fakeInnerRunner(order);
        const poller = fakePoller(order);
        const runner = new BoundedCardStageJobRunner(inner, new RunningCards(), fakeCardJobs() as never, poller, fakePollerSettings(), fakeSettings(), fakeLogger());

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
        const runner = new BoundedCardStageJobRunner(inner, new RunningCards(), fakeCardJobs() as never, poller, fakePollerSettings(), fakeSettings(), fakeLogger());

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
        running.add('project-x', '0099');
        const cardJobs = fakeCardJobs({ '0099': 'job-77' });
        const runner = new BoundedCardStageJobRunner(inner, running, cardJobs as never, poller, fakePollerSettings(), fakeSettings(), fakeLogger());

        await expect(runner.stop()).rejects.toThrow(AbandonedCardJobsError);
        expect(poller.stop).toHaveBeenCalledTimes(1);
        expect(cardJobs.confirmInFlightAfterStop).toHaveBeenCalledWith('0099');
    });

    it('resolves cleanly when nothing was abandoned', async () => {
        const inner = fakeInnerRunner();
        const runner = new BoundedCardStageJobRunner(inner, new RunningCards(), fakeCardJobs() as never, fakePoller(), fakePollerSettings(), fakeSettings(), fakeLogger());

        await expect(runner.stop()).resolves.toBeUndefined();
    });
});

/**
 * Constraint: "Changing concurrency must not disturb running stages ... Lowering it while three
 * stages run must let those three finish; it governs what starts next, not what is already going."
 * Acceptance criterion: "Setting concurrency below the number of running stages leaves those stages
 * running to completion — asserted, not assumed."
 *
 * `reconcileConcurrency` is the private method `watchConcurrency`'s own loop calls on every tick
 * (jobs.module.ts) — reached directly here, the same way `poller.test.ts` reaches `Poller`'s private
 * `tick()`, for a deterministic, single-shot check instead of racing the mocked `delay` loop
 * `start()`/`stop()` drive. `appliedConcurrency` is likewise poked directly: it is a private field
 * this class initialises from the shared, module-level `CARD_STAGE_WORKER` object, so setting it
 * (and that object's `.concurrency`) explicitly up front is what makes each test's "currently
 * applied" starting point exact rather than whatever an earlier test in this file left behind.
 */
describe('BoundedCardStageJobRunner — concurrency reconciliation (card 0115)', () => {
    const reconcile = (runner: InstanceType<typeof BoundedCardStageJobRunner>): Promise<void> =>
        (runner as unknown as { reconcileConcurrency: () => Promise<void> }).reconcileConcurrency();
    const applied = (runner: InstanceType<typeof BoundedCardStageJobRunner>): number =>
        (runner as unknown as { appliedConcurrency: number }).appliedConcurrency;

    it('leaves a running stage alone and defers the change when RunningCards is non-empty', async () => {
        const inner = fakeInnerRunner();
        const poller = fakePoller();
        const running = new RunningCards();
        running.add('project-x', '0099');
        const settings = fakeSettingsFor({ [CARD_STAGE_CONCURRENCY.key]: 1 });
        const logger = fakeLogger();
        const runner = new BoundedCardStageJobRunner(inner, running, fakeCardJobs() as never, poller, fakePollerSettings(), settings, logger);
        (runner as unknown as { appliedConcurrency: number }).appliedConcurrency = 3;
        CARD_STAGE_WORKER.concurrency = 3;

        await reconcile(runner);

        // Nothing touched: no restart of the (still busy) inner runner, no poller pause, and the
        // desired value of 1 is not yet in force — 0099 is still running at the concurrency it
        // started under.
        expect(inner.stop).not.toHaveBeenCalled();
        expect(inner.start).not.toHaveBeenCalled();
        expect(poller.stop).not.toHaveBeenCalled();
        expect(CARD_STAGE_WORKER.concurrency).toBe(3);
        expect(applied(runner)).toBe(3);
        expect(logger.info).not.toHaveBeenCalled();
    });

    it('applies a changed concurrency once the queue is genuinely idle', async () => {
        const order: string[] = [];
        const inner = fakeInnerRunner(order);
        const poller = fakePoller(order);
        const pollerSettings = fakePollerSettings(order);
        const settings = fakeSettingsFor({ [CARD_STAGE_CONCURRENCY.key]: 1 });
        const logger = fakeLogger();
        const runner = new BoundedCardStageJobRunner(inner, new RunningCards(), fakeCardJobs() as never, poller, pollerSettings, settings, logger);
        (runner as unknown as { appliedConcurrency: number }).appliedConcurrency = 3;
        CARD_STAGE_WORKER.concurrency = 3;

        await reconcile(runner);

        // The only moment this class treats a restart as safe: pause the poller, cycle the inner
        // runner (which is what makes pg-boss re-read CARD_STAGE_WORKER.concurrency), then restore
        // the poller's own on/off state — in that order.
        expect(order).toEqual(['poller.stop', 'inner.stop', 'inner.start', 'pollerSettings.applyCurrentValue']);
        expect(CARD_STAGE_WORKER.concurrency).toBe(1);
        expect(applied(runner)).toBe(1);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('applied 1'));
    });

    it('does nothing at all when the setting has not actually changed', async () => {
        const inner = fakeInnerRunner();
        const poller = fakePoller();
        const settings = fakeSettingsFor({ [CARD_STAGE_CONCURRENCY.key]: 3 });
        const logger = fakeLogger();
        const runner = new BoundedCardStageJobRunner(inner, new RunningCards(), fakeCardJobs() as never, poller, fakePollerSettings(), settings, logger);
        (runner as unknown as { appliedConcurrency: number }).appliedConcurrency = 3;
        CARD_STAGE_WORKER.concurrency = 3;

        await reconcile(runner);

        expect(inner.stop).not.toHaveBeenCalled();
        expect(inner.start).not.toHaveBeenCalled();
        expect(poller.stop).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
    });

    /**
     * Review finding on this card: the first `RunningCards` check happens before `poller.stop()` is
     * even called, and `poller.stop()` is itself an `await` — a gap a card.stage job dispatched into
     * a still-live worker can start inside, landing in `RunningCards` after the check passed but
     * before the restart. The fix re-checks `RunningCards` immediately after `poller.stop()` resolves
     * and, finding it non-empty, defers instead of restarting into the stage it would otherwise
     * silently catch — proven here by having the `poller.stop()` fake itself add a running card
     * during the pause, the same race window the real pg-boss dispatch would land in.
     */
    it('re-checks RunningCards right after pausing the poller and defers if a stage started in that gap', async () => {
        const order: string[] = [];
        const inner = fakeInnerRunner(order);
        const running = new RunningCards();
        const poller = {
            stop: vi.fn(async () => {
                order.push('poller.stop');
                // Simulate a card.stage job landing on a still-live worker during the pause.
                running.add('project-x', '0099');
            }),
        } as unknown as import('#modules/jobs/poller.js').Poller;
        const pollerSettings = fakePollerSettings(order);
        const settings = fakeSettingsFor({ [CARD_STAGE_CONCURRENCY.key]: 1 });
        const logger = fakeLogger();
        const runner = new BoundedCardStageJobRunner(inner, running, fakeCardJobs() as never, poller, pollerSettings, settings, logger);
        (runner as unknown as { appliedConcurrency: number }).appliedConcurrency = 3;
        CARD_STAGE_WORKER.concurrency = 3;

        await reconcile(runner);

        // The restart must be aborted entirely: no concurrency mutation, no inner cycle — the stage
        // that snuck in during the pause is left running undisturbed, exactly as one that was already
        // running before the check started would be.
        expect(inner.stop).not.toHaveBeenCalled();
        expect(inner.start).not.toHaveBeenCalled();
        expect(CARD_STAGE_WORKER.concurrency).toBe(3);
        expect(applied(runner)).toBe(3);
        // The poller was paused to make the restart safe; since the restart was aborted, it must be
        // resumed rather than left off — the same call `applyCurrentValue` makes after a real restart.
        expect(pollerSettings.applyCurrentValue).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('deferred'));
    });

    it('catches a settings-read failure and logs it, rather than throwing out of the watcher loop', async () => {
        const inner = fakeInnerRunner();
        const poller = fakePoller();
        const settings = {
            get: vi.fn(async () => {
                throw new Error('settings table unreachable');
            }),
            set: vi.fn(async () => undefined),
        } as unknown as import('#modules/settings/settings.store.js').SettingsStore;
        const logger = fakeLogger();
        const runner = new BoundedCardStageJobRunner(inner, new RunningCards(), fakeCardJobs() as never, poller, fakePollerSettings(), settings, logger);
        (runner as unknown as { appliedConcurrency: number }).appliedConcurrency = 3;

        await expect(reconcile(runner)).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith(expect.any(Error));
        expect(inner.stop).not.toHaveBeenCalled();
        expect(poller.stop).not.toHaveBeenCalled();
    });
});
