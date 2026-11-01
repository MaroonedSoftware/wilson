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

/**
 * `activeCardStageJobs`/`claimForJob` are card 0272's additions, read by the boot sweep
 * (`sweepOrphanedCardStageJobs`). Every existing test in this file constructs a runner and either
 * never calls `start()` at all, or calls it without caring about the sweep — defaulting
 * `activeCardStageJobs` to an empty list keeps the sweep a no-op for all of them, exactly as it would
 * be for a real daemon that has no orphaned jobs to find.
 */
type FakeCardJobs = {
    confirmInFlightAfterStop: ReturnType<typeof vi.fn>;
    activeCardStageJobs: ReturnType<typeof vi.fn>;
    claimForJob: ReturnType<typeof vi.fn>;
};
const fakeCardJobs = (outcomes: Record<string, string | undefined> = {}): FakeCardJobs => ({
    confirmInFlightAfterStop: vi.fn(async (cardId: string) => outcomes[cardId]),
    activeCardStageJobs: vi.fn(async () => []),
    claimForJob: vi.fn(async () => undefined),
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
 * Card 0272. `BoundedCardStageJobRunner` now takes the injected `PgBoss` singleton itself
 * (`start`/`fail`) so `start()`'s boot sweep can fail an orphaned job without going through the
 * broker or `inner`. `start` resolves immediately by default — most tests in this file only care
 * that `start()` completes, not about the sweep — and `fail` resolves with no return value, the same
 * shape the real pg-boss client's `fail(name, id)` has.
 */
const fakePgBoss = (order?: string[]) =>
    ({
        start: vi.fn(async () => {
            order?.push('pgboss.start');
        }),
        fail: vi.fn(async () => {
            order?.push('pgboss.fail');
        }),
    }) as unknown as import('pg-boss').PgBoss;

/** Card 0272. Only `append` is used by the sweep (one `job.orphaned` event per failed job). */
const fakeEvents = (order?: string[]) =>
    ({
        append: vi.fn(async () => {
            order?.push('events.append');
        }),
    }) as unknown as import('#modules/events/event.log.js').EventLog;

/**
 * Card 0272. A `CardJobs` fake whose `activeCardStageJobs` reports specific active jobs, for tests
 * that exercise the boot sweep itself rather than treating it as a no-op — see `fakeCardJobs`'s own
 * doc comment for why the plain fake above always reports none. `claimForJob` stays "no claim found"
 * unless a test overrides it, matching the case every job's own `payload.project` already answers.
 */
const fakeCardJobsWithSweep = (
    jobs: Array<{ jobId: string; payload: { cardId: string; stageName: string; project?: string }; startedOn?: { toISO: () => string } }>,
): FakeCardJobs => ({
    ...fakeCardJobs(),
    activeCardStageJobs: vi.fn(async () => jobs),
});

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
            fakePgBoss(),
            fakeEvents(),
        );

        await runner.start();

        // `fakeCardJobs()`'s `activeCardStageJobs` reports no orphaned jobs, so the sweep does
        // nothing observable here — this order is unaffected by card 0272's addition.
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
            fakePgBoss(),
            fakeEvents(),
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
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            fakeCardJobs() as never,
            poller,
            fakePollerSettings(),
            fakeSettings(),
            fakeLogger(),
            fakePgBoss(),
            fakeEvents(),
        );

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
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            fakeCardJobs() as never,
            poller,
            fakePollerSettings(),
            fakeSettings(),
            fakeLogger(),
            fakePgBoss(),
            fakeEvents(),
        );

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
        const runner = new BoundedCardStageJobRunner(
            inner,
            running,
            cardJobs as never,
            poller,
            fakePollerSettings(),
            fakeSettings(),
            fakeLogger(),
            fakePgBoss(),
            fakeEvents(),
        );

        await expect(runner.stop()).rejects.toThrow(AbandonedCardJobsError);
        expect(poller.stop).toHaveBeenCalledTimes(1);
        expect(cardJobs.confirmInFlightAfterStop).toHaveBeenCalledWith('0099');
    });

    it('resolves cleanly when nothing was abandoned', async () => {
        const inner = fakeInnerRunner();
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            fakeCardJobs() as never,
            fakePoller(),
            fakePollerSettings(),
            fakeSettings(),
            fakeLogger(),
            fakePgBoss(),
            fakeEvents(),
        );

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
        const runner = new BoundedCardStageJobRunner(
            inner,
            running,
            fakeCardJobs() as never,
            poller,
            fakePollerSettings(),
            settings,
            logger,
            fakePgBoss(),
            fakeEvents(),
        );
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
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            fakeCardJobs() as never,
            poller,
            pollerSettings,
            settings,
            logger,
            fakePgBoss(),
            fakeEvents(),
        );
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
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            fakeCardJobs() as never,
            poller,
            fakePollerSettings(),
            settings,
            logger,
            fakePgBoss(),
            fakeEvents(),
        );
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
        const runner = new BoundedCardStageJobRunner(
            inner,
            running,
            fakeCardJobs() as never,
            poller,
            pollerSettings,
            settings,
            logger,
            fakePgBoss(),
            fakeEvents(),
        );
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
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            fakeCardJobs() as never,
            poller,
            fakePollerSettings(),
            settings,
            logger,
            fakePgBoss(),
            fakeEvents(),
        );
        (runner as unknown as { appliedConcurrency: number }).appliedConcurrency = 3;

        await expect(reconcile(runner)).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith(expect.any(Error));
        expect(inner.stop).not.toHaveBeenCalled();
        expect(poller.stop).not.toHaveBeenCalled();
    });
});

/**
 * Card 0272. `start()`'s boot sweep: every `card.stage` job `CardJobs.activeCardStageJobs` reports as
 * `active` gets failed through the injected `PgBoss` singleton, before `inner.start()` registers this
 * process's own `work()` handler, so a job orphaned by an earlier crash is redelivered on pg-boss's
 * ordinary ~30s retry path instead of waiting out `CARD_STAGE_EXPIRES_IN`'s hour.
 */
describe('BoundedCardStageJobRunner — orphaned card.stage sweep (card 0272)', () => {
    const orphanedJob = (overrides: { jobId?: string; project?: string; startedOn?: string | undefined } = {}) => {
        const { startedOn } = overrides;
        return {
            jobId: overrides.jobId ?? 'job-1',
            payload: { cardId: '0001', stageName: 'implementing', project: overrides.project },
            startedOn: startedOn === undefined ? undefined : { toISO: () => startedOn },
        };
    };

    it('fails every active job through pg-boss before inner.start() registers a work() handler — AC1', async () => {
        const order: string[] = [];
        const inner = fakeInnerRunner(order);
        const pgboss = fakePgBoss(order);
        const cardJobs = fakeCardJobsWithSweep([orphanedJob({ jobId: 'job-1' }), orphanedJob({ jobId: 'job-2' })]);
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            cardJobs as never,
            fakePoller(),
            fakePollerSettings(),
            fakeSettings(),
            fakeLogger(),
            pgboss,
            fakeEvents(),
        );

        await runner.start();

        // pg-boss must be started (a live connection is what `fail` asserts) and both orphans failed
        // before `inner.start` ever runs.
        expect(order).toEqual(['pgboss.start', 'pgboss.fail', 'pgboss.fail', 'inner.start']);
        expect(pgboss.fail).toHaveBeenCalledWith('card.stage', 'job-1');
        expect(pgboss.fail).toHaveBeenCalledWith('card.stage', 'job-2');

        await runner.stop();
    });

    it('appends one job.orphaned event per failed job, naming the job id, stage and start time — AC5', async () => {
        const inner = fakeInnerRunner();
        const events = fakeEvents();
        const cardJobs = fakeCardJobsWithSweep([
            orphanedJob({ jobId: 'job-1', project: 'project-a', startedOn: '2026-09-21T12:09:36.000Z' }),
        ]);
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            cardJobs as never,
            fakePoller(),
            fakePollerSettings(),
            fakeSettings(),
            fakeLogger(),
            fakePgBoss(),
            events,
        );

        await runner.start();

        expect(events.append).toHaveBeenCalledWith({
            project: 'project-a',
            cardId: '0001',
            stage: 'implementing',
            type: 'job.orphaned',
            payload: { jobId: 'job-1', startedOn: '2026-09-21T12:09:36.000Z' },
        });

        await runner.stop();
    });

    it('records a null startedOn when pg-boss never recorded one for the job', async () => {
        const inner = fakeInnerRunner();
        const events = fakeEvents();
        const cardJobs = fakeCardJobsWithSweep([orphanedJob({ jobId: 'job-1', project: 'project-a', startedOn: undefined })]);
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            cardJobs as never,
            fakePoller(),
            fakePollerSettings(),
            fakeSettings(),
            fakeLogger(),
            fakePgBoss(),
            events,
        );

        await runner.start();

        expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ payload: { jobId: 'job-1', startedOn: null } }));

        await runner.stop();
    });

    it("falls back to the wilson.cardJobs claim's project when the job's own payload carries none", async () => {
        const inner = fakeInnerRunner();
        const events = fakeEvents();
        const cardJobs = fakeCardJobsWithSweep([orphanedJob({ jobId: 'job-1', project: undefined, startedOn: '2026-09-21T12:09:36.000Z' })]);
        cardJobs.claimForJob = vi.fn(async () => ({ project: 'project-from-claim', cardId: '0001' }));
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            cardJobs as never,
            fakePoller(),
            fakePollerSettings(),
            fakeSettings(),
            fakeLogger(),
            fakePgBoss(),
            events,
        );

        await runner.start();

        expect(cardJobs.claimForJob).toHaveBeenCalledWith('job-1');
        expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ project: 'project-from-claim' }));

        await runner.stop();
    });

    it('still fails the job but appends no event when neither the payload nor the claim names a project', async () => {
        const inner = fakeInnerRunner();
        const pgboss = fakePgBoss();
        const events = fakeEvents();
        const cardJobs = fakeCardJobsWithSweep([orphanedJob({ jobId: 'job-1', project: undefined })]);
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            cardJobs as never,
            fakePoller(),
            fakePollerSettings(),
            fakeSettings(),
            fakeLogger(),
            pgboss,
            events,
        );

        await runner.start();

        expect(pgboss.fail).toHaveBeenCalledWith('card.stage', 'job-1');
        expect(events.append).not.toHaveBeenCalled();

        await runner.stop();
    });

    it('logs and still starts the inner runner when reading active jobs itself fails — AC7', async () => {
        const inner = fakeInnerRunner();
        const logger = fakeLogger();
        const cardJobs = { ...fakeCardJobs(), activeCardStageJobs: vi.fn(async () => Promise.reject(new Error('pgboss.job unreachable'))) };
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            cardJobs as never,
            fakePoller(),
            fakePollerSettings(),
            fakeSettings(),
            logger,
            fakePgBoss(),
            fakeEvents(),
        );

        await expect(runner.start()).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith(expect.any(Error));
        expect(inner.start).toHaveBeenCalledTimes(1);

        await runner.stop();
    });

    it('logs one job.fail failure and still processes the remaining orphans and starts the inner runner — AC7', async () => {
        const inner = fakeInnerRunner();
        const logger = fakeLogger();
        const pgboss = {
            start: vi.fn(async () => undefined),
            fail: vi
                .fn()
                .mockRejectedValueOnce(new Error('job-1 already settled'))
                .mockResolvedValueOnce(undefined),
        } as unknown as import('pg-boss').PgBoss;
        const cardJobs = fakeCardJobsWithSweep([orphanedJob({ jobId: 'job-1' }), orphanedJob({ jobId: 'job-2' })]);
        const runner = new BoundedCardStageJobRunner(
            inner,
            new RunningCards(),
            cardJobs as never,
            fakePoller(),
            fakePollerSettings(),
            fakeSettings(),
            logger,
            pgboss,
            fakeEvents(),
        );

        await expect(runner.start()).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith(expect.any(Error));
        expect(pgboss.fail).toHaveBeenCalledWith('card.stage', 'job-1');
        expect(pgboss.fail).toHaveBeenCalledWith('card.stage', 'job-2');
        expect(inner.start).toHaveBeenCalledTimes(1);

        await runner.stop();
    });

    it('does not run the sweep when reconcileConcurrency restarts the inner runner — AC8', async () => {
        const inner = fakeInnerRunner();
        const poller = fakePoller();
        const pollerSettings = fakePollerSettings();
        const pgboss = fakePgBoss();
        const cardJobs = fakeCardJobsWithSweep([orphanedJob({ jobId: 'job-1' })]);
        const settings = fakeSettingsFor({ [CARD_STAGE_CONCURRENCY.key]: 1 });
        const logger = fakeLogger();
        const runner = new BoundedCardStageJobRunner(inner, new RunningCards(), cardJobs as never, poller, pollerSettings, settings, logger, pgboss, fakeEvents());
        (runner as unknown as { appliedConcurrency: number }).appliedConcurrency = 3;
        CARD_STAGE_WORKER.concurrency = 3;

        await (runner as unknown as { reconcileConcurrency: () => Promise<void> }).reconcileConcurrency();

        // The restart cycles `inner.stop()`/`inner.start()` directly — never `runner.start()` itself —
        // so pg-boss is never asked to start and nothing is ever failed, even though the same
        // `CardJobs` fake would report an orphaned job if the sweep ran.
        expect(pgboss.start).not.toHaveBeenCalled();
        expect(pgboss.fail).not.toHaveBeenCalled();
        expect(cardJobs.activeCardStageJobs).not.toHaveBeenCalled();
        expect(inner.stop).toHaveBeenCalledTimes(1);
        expect(inner.start).toHaveBeenCalledTimes(1);
    });
});
