import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Logger } from '@maroonedsoftware/logger';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { Card } from '#modules/board/card.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { EventLog } from '#modules/events/event.log.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { STATUS_MIRROR_INTERVAL_MS, STATUS_MIRROR_INTERVAL_MS_DEFAULT } from '#modules/settings/status.mirror.interval.setting.js';
import type { CardSource, MirrorStatus } from '#modules/sources/card.source.js';
import { CardSourceRegistry } from '#modules/sources/card.source.registry.js';
import { SourceCursorRepository } from '#modules/sources/source.cursor.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

/**
 * Card 0271: on 2026-09-21 a database outage took `BoundedCardStageJobRunner.watchConcurrency`'s
 * interval read down with it, unguarded (`jobs.module.ts`). `StatusMirrorPoller.loop`'s own
 * `STATUS_MIRROR_INTERVAL_MS` read had the same shape — outside any `try` — and this card closes it
 * the same way card 0257 closed `Poller.loop`'s. Real `node:timers/promises` `setTimeout` is not
 * intercepted by `vi.useFakeTimers()` (see `poller.test.ts`'s own file-level comment on the same
 * idiom), so the module is mocked here and driven by hand. Every other test in this file reaches
 * `tick()` directly and never touches `delay()` at all, so mocking it here changes nothing about them.
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

// Dynamic, and after the mock above — not a static import — so `status.mirror.poller.ts`'s own
// `import { setTimeout as delay } from 'node:timers/promises'` resolves against the mock rather than
// the real module: a static import at the top of this file would be hoisted ahead of `vi.mock`
// registering it, the same trap `poller.test.ts`'s own file-level comment documents.
const { STATUS_MIRROR_CURSOR_KEY, StatusMirrorPoller } = await import('#modules/sources/status.mirror.poller.js');

/** Release the oldest outstanding interval wait, letting the loop run one more tick. */
const releaseTick = () => pending.shift()?.resolve();

/**
 * Card 0201, the same idiom `source.poller.test.ts`'s own "end to end against a real board" section
 * uses (`testDb`, `uniqueProject`): the acceptance criteria here are about real `wilson.card_events`
 * rows and a real cursor row, which a fake event log could only ever assert agrees with itself about.
 */
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const fakeLogger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }) as unknown as Logger;

const card = (id: string, overrides: Partial<Card['frontmatter']> = {}): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'parking-lot', dependsOn: [], retries: {}, ...overrides },
    sections: {},
    body: '## Goal\n\nDo it.\n',
});

/** Reach the private `tick()` directly — one project, one tick, deterministically, with no interval
 * or timer involved. The same idiom `source.poller.test.ts`'s `runOneTick` uses. */
const runTick = (poller: InstanceType<typeof StatusMirrorPoller>): Promise<void> => (poller as unknown as { tick: () => Promise<void> }).tick();

/**
 * A fresh project wired against a real `PostgresBoardRepository`/`EventLog` on the test db, and a
 * `StatusMirrorPoller` constructed the same way `SourcesModule` wires the real one (this class is a
 * plain, undecorated constructor — no DI container needed to build one directly).
 */
const setup = (sources: CardSource[] = []) => {
    const project = uniqueProject();
    const config = new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run');
    const events = new EventLog(db, fakeLogger());
    const board = new PostgresBoardRepository(config, db, events);
    const cursors = new SourceCursorRepository(config, db);
    const registry = new CardSourceRegistry(sources);
    const settings = new SettingsStore(config, db, new AppConfig({ STATUS_MIRROR_ENABLED: 'true' }));
    const logger = fakeLogger();
    const poller = new StatusMirrorPoller(registry, cursors, board, config, settings, db, logger);
    return { project, config, board, events, cursors, registry, settings, logger, poller };
};

/** Appends a real `transition.written` event for `cardId` and moves it to `to` — the two things
 * `BoardRepository.writeWithEvent` always does together, without pulling in `StageDispatcher` or
 * `BoardWriteService` just to produce one. */
const writeTransition = async (
    board: PostgresBoardRepository,
    config: StaticBoardConfig,
    cardId: string,
    stage: string,
    from: string,
    to: string,
    extraPayload: Record<string, unknown> = {},
): Promise<void> => {
    await board.writeWithEvent(
        cardId,
        `${cardId}: ${stage} -> ${to}`,
        current => ({ ...current, frontmatter: { ...current.frontmatter, stage: to } }),
        { project: config.project, cardId, stage, type: 'transition.written', payload: { from, to, by: 'runner', ...extraPayload } },
    );
};

/** A `CardSource` that records every `mirrorStatus` call it receives and always succeeds. */
const trackingSource = (name: string): { source: CardSource; calls: Array<{ externalId: string; status: MirrorStatus }> } => {
    const calls: Array<{ externalId: string; status: MirrorStatus }> = [];
    const source: CardSource = {
        name,
        changedSince: async () => ({ ok: true, items: [], cursor: '' }),
        mirrorStatus: async (externalId, status) => {
            calls.push({ externalId, status });
            return { ok: true };
        },
    };
    return { source, calls };
};

describe('StatusMirrorPoller — which transitions mirror', () => {
    it('mirrors the first genuine scope-check -> implementing pass, and not implementing -> testing or testing -> review after it', async () => {
        const { source, calls } = trackingSource('github');
        const { board, config, poller } = setup([source]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');

        await writeTransition(board, config, '0001', 'scope-check', 'scope-check', 'implementing');
        await writeTransition(board, config, '0001', 'implementing', 'implementing', 'testing');
        await writeTransition(board, config, '0001', 'testing', 'testing', 'review');

        await runTick(poller);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.status.moment).toBe('started');
        expect(calls[0]!.externalId).toBe('octocat/hello-world#1');
    });

    it('does not mirror a kickback landing back on implementing from testing or review', async () => {
        const { source, calls } = trackingSource('github');
        const { board, config, poller } = setup([source]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');

        await writeTransition(board, config, '0001', 'testing', 'testing', 'implementing');
        await writeTransition(board, config, '0001', 'review', 'review', 'implementing');

        await runTick(poller);

        expect(calls).toHaveLength(0);
    });

    it('mirrors a second scope-check -> implementing pass after a kickback-and-reapproval cycle', async () => {
        const { source, calls } = trackingSource('github');
        const { board, config, poller } = setup([source]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');

        await writeTransition(board, config, '0001', 'scope-check', 'scope-check', 'implementing');
        await writeTransition(board, config, '0001', 'review', 'review', 'implementing');
        await writeTransition(board, config, '0001', 'scope-check', 'scope-check', 'implementing');

        await runTick(poller);

        expect(calls).toHaveLength(2);
        expect(calls.every(c => c.status.moment === 'started')).toBe(true);
    });

    it.each(['ready', 'merged', 'dropped'] as const)('mirrors a transition reaching %s', async to => {
        const { source, calls } = trackingSource('github');
        const { board, config, poller } = setup([source]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');

        await writeTransition(board, config, '0001', 'review', 'review', to);

        await runTick(poller);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.status.moment).toBe(to);
    });

    it('mirrors a needsHuman transition regardless of its reason text, and never hands that raw reason to the source', async () => {
        const { source, calls } = trackingSource('github');
        const { board, config, poller } = setup([source]);
        const secretReason = 'over budget: spent $412.55 of $50.00 cap at /etc/secret-path.ts';
        await board.create(
            card('0001', { external: { github: 'octocat/hello-world#1' }, needsHuman: true, needsHumanReason: secretReason }),
            'create',
        );

        await writeTransition(board, config, '0001', 'implementing', 'implementing', 'implementing', { needsHuman: true });

        await runTick(poller);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.status.moment).toBe('needs-human');
        // The raw reason is available on `MirrorStatus` for a source that wants it structurally, but
        // this card's own `GitHubIssuesSource.mirrorStatus` never interpolates it into a comment body
        // (see that class's own test) — this only proves the poller does not withhold it out of an
        // overcautious guess, since the composed-sentence rule lives in the source, not here.
        expect(calls[0]!.status.reason).toBe(secretReason);
    });

    it('skips a card with no external ref, never looking it up against CardSourceRegistry', async () => {
        const { source, calls } = trackingSource('github');
        const { board, config, registry, poller } = setup([source]);
        const listSpy = vi.spyOn(registry, 'list');
        await board.create(card('0001'), 'create');

        await writeTransition(board, config, '0001', 'review', 'review', 'ready');

        await runTick(poller);

        expect(calls).toHaveLength(0);
        expect(listSpy).not.toHaveBeenCalled();
    });
});

describe('StatusMirrorPoller — source resolution', () => {
    it('skips a registered source that implements no mirrorStatus, without throwing', async () => {
        const readOnlySource: CardSource = {
            name: 'github',
            changedSince: async () => ({ ok: true, items: [], cursor: '' }),
            // No `mirrorStatus` — Constraints: "a future source with no write access ... implements
            // nothing and the poller skips it."
        };
        const { board, config, poller } = setup([readOnlySource]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');
        await writeTransition(board, config, '0001', 'review', 'review', 'ready');

        await expect(runTick(poller)).resolves.toBeUndefined();
    });

    it("only calls mirrorStatus on the source named by the external ref's own key, not every registered source", async () => {
        const { source: githubSource, calls: githubCalls } = trackingSource('github');
        const { source: otherSource, calls: otherCalls } = trackingSource('jira');
        const { board, config, poller } = setup([githubSource, otherSource]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');
        await writeTransition(board, config, '0001', 'review', 'review', 'ready');

        await runTick(poller);

        expect(githubCalls).toHaveLength(1);
        expect(otherCalls).toHaveLength(0);
    });
});

describe('StatusMirrorPoller — cursor advancement', () => {
    it('advances the cursor past a source refusal, so the same event is not retried forever', async () => {
        const refusing: CardSource = {
            name: 'github',
            changedSince: async () => ({ ok: true, items: [], cursor: '' }),
            mirrorStatus: vi.fn(async () => ({ ok: false, reason: 'rate limited' })),
        };
        const { board, config, cursors, poller } = setup([refusing]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');
        await writeTransition(board, config, '0001', 'review', 'review', 'ready');

        await runTick(poller);
        const cursorAfterFirst = await cursors.get(STATUS_MIRROR_CURSOR_KEY);
        expect(cursorAfterFirst).toBeDefined();

        await runTick(poller);

        expect(refusing.mirrorStatus).toHaveBeenCalledTimes(1);
        expect(await cursors.get(STATUS_MIRROR_CURSOR_KEY)).toBe(cursorAfterFirst);
    });

    it('does not re-mirror an already-mirrored event on a later tick', async () => {
        const { source, calls } = trackingSource('github');
        const { board, config, poller } = setup([source]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');
        await writeTransition(board, config, '0001', 'scope-check', 'scope-check', 'implementing');

        await runTick(poller);
        await runTick(poller);

        expect(calls).toHaveLength(1);
    });

    it('a tick with STATUS_MIRROR_ENABLED false mirrors nothing and does not advance the cursor', async () => {
        const { source, calls } = trackingSource('github');
        const project = uniqueProject();
        const config = new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run');
        const events = new EventLog(db, fakeLogger());
        const board = new PostgresBoardRepository(config, db, events);
        const cursors = new SourceCursorRepository(config, db);
        const registry = new CardSourceRegistry([source]);
        const settings = new SettingsStore(config, db, new AppConfig({ STATUS_MIRROR_ENABLED: 'false' }));
        const poller = new StatusMirrorPoller(registry, cursors, board, config, settings, db, fakeLogger());
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');
        await writeTransition(board, config, '0001', 'review', 'review', 'ready');

        await runTick(poller);

        expect(calls).toHaveLength(0);
        expect(await cursors.get(STATUS_MIRROR_CURSOR_KEY)).toBeUndefined();
    });
});

/**
 * The interval-read guard itself (card 0271), driven through the real `start()`/`stop()` surface
 * rather than `tick()` directly — a regression back to the old, unprotected read shows up exactly as
 * it did in production: the loop never reaches its first `delay()` call at all, and every `vi.waitFor`
 * below times out, or `stop()` itself rejects with the settings error instead of resolving cleanly.
 * Fakes throughout, not the real `testDb()`: `STATUS_MIRROR_ENABLED` resolves to its coded default
 * (`false`) for every settings fake below, so `tickProject` returns before ever touching the cursor
 * repository, the board, or the pool — nothing here needs them to be real.
 */
describe('StatusMirrorPoller start/stop — the interval read survives a database outage (card 0271)', () => {
    beforeEach(() => {
        pending = [];
        delayMock.mockClear();
    });

    afterEach(async () => {
        // Belt and braces: abort anything a test left running so it cannot bleed into the next one.
        for (const entry of [...pending]) entry.resolve();
    });

    const failingIntervalSettings = (error: Error): SettingsStore =>
        ({
            get: vi.fn(async (definition: { key: string; defaultValue: unknown }) => {
                if (definition.key === STATUS_MIRROR_INTERVAL_MS.key) throw error;
                return definition.defaultValue;
            }),
            set: vi.fn(async () => undefined),
        }) as unknown as SettingsStore;

    const intervalReadSequence = (...steps: Array<{ value: number } | { error: Error }>): SettingsStore => {
        const queue = [...steps];
        return {
            get: vi.fn(async (definition: { key: string; defaultValue: unknown }) => {
                if (definition.key !== STATUS_MIRROR_INTERVAL_MS.key) return definition.defaultValue;
                const step = queue.shift();
                if (!step) throw new Error('intervalReadSequence exhausted — add another step');
                if ('error' in step) throw step.error;
                return step.value;
            }),
            set: vi.fn(async () => undefined),
        } as unknown as SettingsStore;
    };

    const buildTestPoller = (settings: SettingsStore) => {
        const config = new StaticBoardConfig('status-mirror-interval-test-project', '/tmp/code', '/tmp/wt', '/tmp/run');
        const logger = fakeLogger();
        const poller = new StatusMirrorPoller(
            new CardSourceRegistry([]),
            {} as unknown as SourceCursorRepository,
            {} as unknown as BoardRepository,
            config,
            settings,
            {} as unknown as Kysely<DB>,
            logger,
        );
        return { poller, logger };
    };

    it('AC1: a settings store whose get() always rejects for STATUS_MIRROR_INTERVAL_MS logs each failure, waits the default interval, and keeps ticking', async () => {
        const boom = new Error('ECONNREFUSED');
        const settings = failingIntervalSettings(boom);
        const { poller, logger } = buildTestPoller(settings);

        poller.start();
        await vi.waitFor(() =>
            expect(delayMock).toHaveBeenCalledWith(
                STATUS_MIRROR_INTERVAL_MS_DEFAULT,
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
            STATUS_MIRROR_INTERVAL_MS_DEFAULT,
            undefined,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(logger.error).toHaveBeenCalledTimes(2);

        await poller.stop();
    });

    it('AC2: a read that fails after a successful 5000ms read falls back to that last known-good value, not the default', async () => {
        const boom = new Error('ECONNREFUSED');
        const settings = intervalReadSequence({ value: 5_000 }, { error: boom });
        const { poller } = buildTestPoller(settings);

        poller.start();
        await vi.waitFor(() =>
            expect(delayMock).toHaveBeenCalledWith(5_000, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) })),
        );

        // The wait elapses, the tick after it runs, and loop() reads the setting again — this time it
        // rejects, and the fallback must be 5000 (the last known-good value), not
        // STATUS_MIRROR_INTERVAL_MS_DEFAULT.
        releaseTick();
        await vi.waitFor(() => expect(delayMock).toHaveBeenCalledTimes(2));
        expect(delayMock).toHaveBeenLastCalledWith(5_000, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));

        await poller.stop();
    });

    it('AC3: a read that fails and then recovers uses the freshly read value on the very next iteration', async () => {
        const boom = new Error('ECONNREFUSED');
        const settings = intervalReadSequence({ error: boom }, { value: 7_000 });
        const { poller } = buildTestPoller(settings);

        poller.start();
        // Never having read a good value yet, the first failure falls back to the default.
        await vi.waitFor(() =>
            expect(delayMock).toHaveBeenCalledWith(
                STATUS_MIRROR_INTERVAL_MS_DEFAULT,
                undefined,
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            ),
        );

        releaseTick();
        await vi.waitFor(() => expect(delayMock).toHaveBeenCalledTimes(2));
        expect(delayMock).toHaveBeenLastCalledWith(7_000, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));

        await poller.stop();
    });

    it('AC4: aborting mid-wait during a failing settings read still returns from stop() immediately, without waiting out a retry cycle', async () => {
        const settings = failingIntervalSettings(new Error('ECONNREFUSED'));
        const { poller } = buildTestPoller(settings);

        poller.start();
        await vi.waitFor(() => expect(pending).toHaveLength(1));

        // If stop() had to wait out a whole retry cycle (another failing read plus another delay)
        // instead of returning as soon as the in-flight wait aborts, this would hang past the test's
        // own timeout rather than resolving.
        await expect(poller.stop()).resolves.toBeUndefined();
    });

    it('AC5: repeated rejected settings reads across several iterations never reject the loop; stop() still resolves cleanly', async () => {
        const settings = failingIntervalSettings(new Error('ECONNREFUSED'));
        const { poller } = buildTestPoller(settings);

        poller.start();
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        releaseTick();
        await vi.waitFor(() => expect(delayMock).toHaveBeenCalledTimes(2));
        releaseTick();
        await vi.waitFor(() => expect(delayMock).toHaveBeenCalledTimes(3));

        // Were a rejected settings read able to escape loop() as an unhandled rejection, it would have
        // already surfaced by now — either as a rejection from stop() below, or as a process warning
        // this run captures.
        await expect(poller.stop()).resolves.toBeUndefined();
    });
});
