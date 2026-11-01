import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRunner } from '@maroonedsoftware/jobbroker';

/**
 * Card 0271: on 2026-09-21 the compose stack restarted and the daemon died on `ECONNREFUSED` thrown
 * by `SettingsStore.get` from `BoundedCardStageJobRunner.watchConcurrency` (`jobs.module.ts`) — the
 * interval read there sat outside any `try`, so a rejected read became an unhandled rejection that
 * took the whole process down. This file drives the real `start()`/`stop()` surface (not the private
 * `watchConcurrency` directly), the same idiom `poller.test.ts` uses for the identical fix to
 * `Poller.loop` (card 0257): real `node:timers/promises` `setTimeout` is not intercepted by
 * `vi.useFakeTimers()`, so the module is mocked here and driven by hand via a pending/release queue.
 * A regression back to the old, unprotected read shows up exactly as it did in production: the loop
 * never reaches its first `delay()` call at all (it throws before that point), and every `vi.waitFor`
 * below times out, or `stop()` itself rejects with the settings error instead of resolving cleanly.
 */
interface PendingDelay {
    resolve: () => void;
}
let pending: PendingDelay[] = [];

const delayMock = vi.fn((_ms: number, _value: undefined, opts: { signal: AbortSignal }) => {
    return new Promise<void>((resolve, reject) => {
        const entry: PendingDelay = {
            resolve: () => {
                opts.signal.removeEventListener('abort', onAbort);
                pending = pending.filter(p => p !== entry);
                resolve();
            },
        };
        const onAbort = () => {
            pending = pending.filter(p => p !== entry);
            reject(new Error('AbortError'));
        };
        if (opts.signal.aborted) {
            onAbort();
            return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
        pending.push(entry);
    });
});
vi.mock('node:timers/promises', () => ({ setTimeout: delayMock }));

const { BoundedCardStageJobRunner } = await import('#modules/jobs/jobs.module.js');
const { RunningCards } = await import('#modules/jobs/running.cards.js');
const { POLLER_INTERVAL_MS_DEFAULT } = await import('#modules/jobs/job.runner.config.js');
const { POLLER_INTERVAL_MS } = await import('#modules/settings/poller.interval.setting.js');
const { CARD_STAGE_CONCURRENCY } = await import('#modules/settings/card.stage.concurrency.setting.js');

/** Release the oldest outstanding interval wait, letting the watcher loop run one more cycle. */
const releaseTick = () => pending.shift()?.resolve();

const fakeInnerRunner = (): JobRunner =>
    ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
    }) as unknown as JobRunner;

const fakePoller = () => ({ stop: vi.fn(async () => undefined) }) as unknown as import('#modules/jobs/poller.js').Poller;

const fakePollerSettings = () =>
    ({ applyCurrentValue: vi.fn(async () => undefined) }) as unknown as import('#modules/settings/poller.setting.service.js').PollerSettingService;

// Card 0272 added `activeCardStageJobs`/`claimForJob`, read by `start()`'s boot sweep. Reporting no
// active jobs keeps the sweep a no-op, so these tests still observe only the interval-read loop.
const fakeCardJobs = () =>
    ({
        confirmInFlightAfterStop: vi.fn(async () => undefined),
        activeCardStageJobs: vi.fn(async () => []),
        claimForJob: vi.fn(async () => undefined),
    }) as never;

const fakeLogger = (): import('@maroonedsoftware/logger').Logger =>
    ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as import('@maroonedsoftware/logger').Logger;

// Card 0272: `BoundedCardStageJobRunner` now also takes the injected `PgBoss` singleton and
// `EventLog` for the boot sweep. `start` and `fail` both resolve immediately — the sweep itself is
// exercised in `bounded.card.stage.job.runner.test.ts`, not here.
const fakePgBoss = () => ({ start: vi.fn(async () => undefined), fail: vi.fn(async () => undefined) }) as unknown as import('pg-boss').PgBoss;
const fakeEvents = () => ({ append: vi.fn(async () => undefined) }) as unknown as import('#modules/events/event.log.js').EventLog;

/**
 * A `SettingsStore` fake for `POLLER_INTERVAL_MS` (the interval `watchConcurrency` reads) whose
 * `get()` always rejects for that one definition — every other definition (`CARD_STAGE_CONCURRENCY`
 * among them, read by both `start()` and `reconcileConcurrency`) resolves its own coded default, so
 * `reconcileConcurrency` always finds "nothing changed" and never itself restarts anything, leaving
 * these tests free to observe the interval read in isolation.
 */
const failingIntervalSettings = (error: Error): import('#modules/settings/settings.store.js').SettingsStore =>
    ({
        get: vi.fn(async (definition: { key: string; defaultValue: unknown }) => {
            if (definition.key === POLLER_INTERVAL_MS.key) throw error;
            return definition.defaultValue;
        }),
        set: vi.fn(async () => undefined),
    }) as unknown as import('#modules/settings/settings.store.js').SettingsStore;

const intervalReadSequence = (...steps: Array<{ value: number } | { error: Error }>): import('#modules/settings/settings.store.js').SettingsStore => {
    const queue = [...steps];
    return {
        get: vi.fn(async (definition: { key: string; defaultValue: unknown }) => {
            if (definition.key !== POLLER_INTERVAL_MS.key) return definition.defaultValue;
            const step = queue.shift();
            if (!step) throw new Error('intervalReadSequence exhausted — add another step');
            if ('error' in step) throw step.error;
            return step.value;
        }),
        set: vi.fn(async () => undefined),
    } as unknown as import('#modules/settings/settings.store.js').SettingsStore;
};

const buildRunner = (settings: import('#modules/settings/settings.store.js').SettingsStore) => {
    const logger = fakeLogger();
    const runner = new BoundedCardStageJobRunner(
        fakeInnerRunner(),
        new RunningCards(),
        fakeCardJobs(),
        fakePoller(),
        fakePollerSettings(),
        settings,
        logger,
        fakePgBoss(),
        fakeEvents(),
    );
    return { runner, logger };
};

describe('BoundedCardStageJobRunner.watchConcurrency — the interval read survives a database outage (card 0271)', () => {
    beforeEach(() => {
        pending = [];
        delayMock.mockClear();
    });

    afterEach(async () => {
        // Belt and braces: abort anything a test left running so it cannot bleed into the next one.
        for (const entry of [...pending]) entry.resolve();
    });

    it('AC1: a settings store whose get() always rejects for POLLER_INTERVAL_MS logs each failure, waits the default interval, and keeps looping', async () => {
        const boom = new Error('ECONNREFUSED');
        const settings = failingIntervalSettings(boom);
        const { runner, logger } = buildRunner(settings);

        await runner.start();
        await vi.waitFor(() =>
            expect(delayMock).toHaveBeenCalledWith(
                POLLER_INTERVAL_MS_DEFAULT,
                undefined,
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            ),
        );
        expect(logger.error).toHaveBeenCalledWith(boom);

        // A second failing iteration behaves exactly like the first — logs again, waits the default
        // again — rather than busy-looping or giving up after a single retry.
        releaseTick();
        await vi.waitFor(() => expect(delayMock).toHaveBeenCalledTimes(2));
        expect(delayMock).toHaveBeenLastCalledWith(
            POLLER_INTERVAL_MS_DEFAULT,
            undefined,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(logger.error).toHaveBeenCalledTimes(2);

        await expect(runner.stop()).resolves.toBeUndefined();
    });

    it('AC2: a read that fails after a successful 5000ms read falls back to that last known-good value, not the default', async () => {
        const boom = new Error('ECONNREFUSED');
        const settings = intervalReadSequence({ value: 5_000 }, { error: boom });
        const { runner } = buildRunner(settings);

        await runner.start();
        await vi.waitFor(() =>
            expect(delayMock).toHaveBeenCalledWith(5_000, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) })),
        );

        // The wait elapses, the watcher's own tick (reconcileConcurrency) runs, and the loop reads the
        // setting again — this time it rejects, and the fallback must be 5000 (the last known-good
        // value), not POLLER_INTERVAL_MS_DEFAULT.
        releaseTick();
        await vi.waitFor(() => expect(delayMock).toHaveBeenCalledTimes(2));
        expect(delayMock).toHaveBeenLastCalledWith(5_000, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));

        await expect(runner.stop()).resolves.toBeUndefined();
    });

    it('AC3: a read that fails and then recovers uses the freshly read value on the very next iteration', async () => {
        const boom = new Error('ECONNREFUSED');
        const settings = intervalReadSequence({ error: boom }, { value: 7_000 });
        const { runner } = buildRunner(settings);

        await runner.start();
        // Never having read a good value yet, the first failure falls back to the default.
        await vi.waitFor(() =>
            expect(delayMock).toHaveBeenCalledWith(
                POLLER_INTERVAL_MS_DEFAULT,
                undefined,
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            ),
        );

        releaseTick();
        await vi.waitFor(() => expect(delayMock).toHaveBeenCalledTimes(2));
        expect(delayMock).toHaveBeenLastCalledWith(7_000, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));

        await expect(runner.stop()).resolves.toBeUndefined();
    });

    it('AC4: aborting mid-wait during a failing settings read still returns from stop() immediately, without waiting out a retry cycle', async () => {
        const settings = failingIntervalSettings(new Error('ECONNREFUSED'));
        const { runner } = buildRunner(settings);

        await runner.start();
        await vi.waitFor(() => expect(pending).toHaveLength(1));

        const concurrencyCallsAtStart = (settings.get as ReturnType<typeof vi.fn>).mock.calls.filter(
            (c: unknown[]) => (c[0] as { key: string }).key === CARD_STAGE_CONCURRENCY.key,
        ).length;

        // If stop() had to wait out a whole retry cycle (another failing read plus another delay,
        // followed by reconcileConcurrency's own settings read) instead of returning as soon as the
        // in-flight wait aborts, this would hang past the test's own timeout rather than resolving —
        // and reconcileConcurrency would have run at least once more in the meantime.
        await expect(runner.stop()).resolves.toBeUndefined();

        const concurrencyCallsAfterStop = (settings.get as ReturnType<typeof vi.fn>).mock.calls.filter(
            (c: unknown[]) => (c[0] as { key: string }).key === CARD_STAGE_CONCURRENCY.key,
        ).length;
        expect(concurrencyCallsAfterStop).toBe(concurrencyCallsAtStart);
    });

    it('AC5: repeated rejected settings reads across several iterations never reject the loop; stop() still resolves cleanly', async () => {
        const settings = failingIntervalSettings(new Error('ECONNREFUSED'));
        const { runner } = buildRunner(settings);

        await runner.start();
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        releaseTick();
        await vi.waitFor(() => expect(delayMock).toHaveBeenCalledTimes(2));
        releaseTick();
        await vi.waitFor(() => expect(delayMock).toHaveBeenCalledTimes(3));
        releaseTick();
        await vi.waitFor(() => expect(delayMock).toHaveBeenCalledTimes(4));

        // Were a rejected settings read able to escape the watcher loop as an unhandled rejection, it
        // would have already surfaced by now — either as a rejection from stop() below, or as a
        // process warning this run captures.
        await expect(runner.stop()).resolves.toBeUndefined();
    });
});
