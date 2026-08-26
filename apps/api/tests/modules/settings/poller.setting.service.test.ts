import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import type { Logger } from '@maroonedsoftware/logger';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { PollerSettingService } from '#modules/settings/poller.setting.service.js';
import { POLLER_ENABLED } from '#modules/settings/poller.enabled.setting.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { Poller } from '#modules/jobs/poller.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';
import { ensureSettingsTable } from './ensure.settings.table.js';

let db: Kysely<DB>;
beforeAll(async () => {
    db = testDb();
    await ensureSettingsTable(db);
});
afterAll(async () => {
    await db.destroy();
});

const fakeAppConfig = (env: Record<string, string> = {}): AppConfig => ({ get: (key: string, fallback = '') => env[key] ?? fallback }) as unknown as AppConfig;

/** A fake `Poller` — every test in this file but one uses this rather than a real timer. */
const fakePoller = () => ({ start: vi.fn(), stop: vi.fn(async () => {}) });

const buildService = (env: Record<string, string> = {}) => {
    const config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
    const settings = new SettingsStore(config, db, fakeAppConfig(env));
    const poller = fakePoller();
    const service = new PollerSettingService(settings, poller as unknown as Poller);
    return { service, settings, poller };
};

/**
 * Card 0106. `PollerSettingService` is what makes the poller-enabled setting live: a write reaches
 * the running `Poller` immediately, and the same resolution runs again at boot
 * (`BoundedCardStageJobRunner.start()`, jobs.module.ts) so a database row already in place takes
 * effect without anyone having to call `set()` first.
 */
describe('PollerSettingService.get', () => {
    it('reports off with no database row and no POLLER_ENABLED, matching the coded default', async () => {
        const { service } = buildService();

        expect(await service.get()).toEqual({ enabled: false });
    });

    it.each(['true', 'false'])('reports POLLER_ENABLED (%s) with no database row — tested for both values', async raw => {
        const { service } = buildService({ POLLER_ENABLED: raw });

        expect(await service.get()).toEqual({ enabled: raw === 'true' });
    });

    it('reports a database row over POLLER_ENABLED', async () => {
        const { service, settings } = buildService({ POLLER_ENABLED: 'true' });
        await settings.set(POLLER_ENABLED, false);

        expect(await service.get()).toEqual({ enabled: false });
    });
});

describe('PollerSettingService.set', () => {
    it('persists the value and starts the poller when enabling it', async () => {
        const { service, poller, settings } = buildService();

        const result = await service.set({ enabled: true });

        expect(result).toEqual({ enabled: true });
        expect(poller.start).toHaveBeenCalledTimes(1);
        expect(poller.stop).not.toHaveBeenCalled();
        expect(await settings.get(POLLER_ENABLED)).toBe(true);
    });

    /**
     * The constraint this proves (card 0106's plan: "Poller.stop() stops enqueueing; jobs already
     * running are the queue's business and continue. Assert that, do not assume it."): disabling the
     * poller through a settings write reaches only the poller's own timer, never anything that could
     * touch a card a worker already has in flight. `PollerSettingService`'s only collaborators are
     * `SettingsStore` and `Poller` — it holds no reference to `RunningCards`, `CardJobs`, or
     * `JobRunner` at all, so `Poller.stop()` is the only call this method is even capable of making
     * toward "stop something" — and `Poller.stop()`'s own contract (poller.ts, poller.test.ts) is
     * that it stops enqueueing and waits out a tick already in flight, nothing more.
     */
    it('persists the value and stops the poller when disabling it — and calls nothing else', async () => {
        const { service, poller, settings } = buildService();

        const result = await service.set({ enabled: false });

        expect(result).toEqual({ enabled: false });
        expect(poller.stop).toHaveBeenCalledTimes(1);
        expect(poller.start).not.toHaveBeenCalled();
        expect(await settings.get(POLLER_ENABLED)).toBe(false);
    });

    /**
     * Real `Poller`, not the fake: `Poller.start()`'s idempotency (poller.test.ts) is what has to
     * hold here for "no second timer" to be true, and only a real instance can prove it. Checked via
     * `AbortController` identity — the same internal `Poller` creates fresh on every genuine start —
     * rather than by timing, so this cannot pass by accident.
     */
    it('setting the same value twice does not start a second timer', async () => {
        const project = uniqueProject();
        const config = new StaticBoardConfig(project, '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        const settings = new SettingsStore(config, db, fakeAppConfig());
        const board = { list: vi.fn(async () => []) };
        const poller = new Poller(
            board as unknown as BoardRepository,
            config,
            { send: vi.fn() } as unknown as JobBroker,
            { inFlight: vi.fn(), record: vi.fn(), clear: vi.fn() } as unknown as CardJobs,
            { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
        );
        const service = new PollerSettingService(settings, poller);

        await service.set({ enabled: true });
        const abortAfterFirst = (poller as unknown as { abort?: AbortController }).abort;
        expect(abortAfterFirst).toBeDefined();

        await service.set({ enabled: true });

        expect((poller as unknown as { abort?: AbortController }).abort).toBe(abortAfterFirst);

        await poller.stop();
    });
});

describe('PollerSettingService.applyCurrentValue', () => {
    it.each(['true', 'false'])('starts or stops the poller to match a fresh database with POLLER_ENABLED=%s', async raw => {
        const { service, poller } = buildService({ POLLER_ENABLED: raw });

        const result = await service.applyCurrentValue();

        expect(result).toEqual({ enabled: raw === 'true' });
        if (raw === 'true') {
            expect(poller.start).toHaveBeenCalledTimes(1);
            expect(poller.stop).not.toHaveBeenCalled();
        } else {
            expect(poller.stop).toHaveBeenCalledTimes(1);
            expect(poller.start).not.toHaveBeenCalled();
        }
    });

    it('a database row still overrides POLLER_ENABLED when applied this way', async () => {
        const { service, poller, settings } = buildService({ POLLER_ENABLED: 'true' });
        await settings.set(POLLER_ENABLED, false);

        await service.applyCurrentValue();

        expect(poller.stop).toHaveBeenCalledTimes(1);
        expect(poller.start).not.toHaveBeenCalled();
    });
});
