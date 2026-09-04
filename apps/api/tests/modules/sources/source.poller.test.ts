import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Logger } from '@maroonedsoftware/logger';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ProjectScopedBoardConfig, StaticBoardConfig, type BoardConfig } from '#modules/board/board.config.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { ProjectRepository, ProjectRow } from '#modules/board/project.repository.js';
import type { EventLog } from '#modules/events/event.log.js';
import { CardJobs } from '#modules/jobs/card.jobs.js';
import { RunningCards } from '#modules/jobs/running.cards.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { SOURCE_POLL_INTERVAL_MS_DEFAULT } from '#modules/settings/source.poll.interval.setting.js';
import { CardSourceRegistry } from '#modules/sources/card.source.registry.js';
import type { CardSource } from '#modules/sources/card.source.js';
import { InboundCardWriter } from '#modules/sources/inbound.card.writer.js';
import { CacheIdempotencyStore } from '@maroonedsoftware/cache';
import { PostgresCacheProvider } from '#modules/sources/postgres.cache.provider.js';
import { SourceCursorRepository } from '#modules/sources/source.cursor.repository.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

/**
 * Card 0198, same idiom `poller.test.ts` uses (see that file's own doc comment): real
 * `node:timers/promises` `setTimeout` is not intercepted by `vi.useFakeTimers()`, so the module is
 * mocked here and driven by hand, letting the `start`/`stop` tests below control exactly when a tick
 * fires without waiting out the real production interval.
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

const { SourcePoller } = await import('#modules/sources/source.poller.js');

/** Release the oldest outstanding interval wait, letting the loop run one more tick. */
const releaseTick = () => pending.shift()?.resolve();

/** Reach the private `tick()` directly: one tick, deterministically, with no interval/timer involved. */
const runOneTick = (poller: InstanceType<typeof SourcePoller>): Promise<void> => (poller as unknown as { tick: () => Promise<void> }).tick();

const fakeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }) as unknown as Logger;

/** A `CardSourceRegistry`-agnostic `CardSource` fake: records every cursor it was asked with, and
 * hands back a canned sequence of results (the last one repeats once exhausted). */
const trackingSource = (name: string, results: Array<{ ok: true; items: never[]; cursor: string }>): { source: CardSource; receivedCursors: (string | undefined)[] } => {
    const receivedCursors: (string | undefined)[] = [];
    let call = 0;
    const source: CardSource = {
        name,
        changedSince: async cursor => {
            receivedCursors.push(cursor);
            const result = results[Math.min(call, results.length - 1)]!;
            call += 1;
            return result;
        },
    };
    return { source, receivedCursors };
};

/** A `SettingsStore` fake keyed by `(config.project, definition.key)` — project-aware, the way the
 * real store is, so `SOURCE_POLL_ENABLED`'s per-project scope is exercised for real rather than
 * assumed. Values not named in `perProject` fall through to the definition's own coded default. */
const fakeSettingsStore = (config: BoardConfig, perProject: Record<string, Record<string, unknown>> = {}): SettingsStore =>
    ({
        get: vi.fn(async (definition: { key: string; defaultValue: unknown }) => {
            const row = perProject[config.project];
            return row && definition.key in row ? row[definition.key] : definition.defaultValue;
        }),
        set: vi.fn(async () => undefined),
    }) as unknown as SettingsStore;

const fakeCursorRepo = (): SourceCursorRepository => {
    const store = new Map<string, string>();
    return {
        get: vi.fn(async (source: string) => store.get(source)),
        set: vi.fn(async (source: string, cursor: string) => {
            store.set(source, cursor);
        }),
    } as unknown as SourceCursorRepository;
};

const fakeWriter = (): InboundCardWriter => ({ apply: vi.fn(async () => {}) }) as unknown as InboundCardWriter;

const buildPoller = (
    sources: CardSource[],
    deps: Partial<{
        cursors: SourceCursorRepository;
        writer: InboundCardWriter;
        settings: SettingsStore;
        logger: Logger;
        projects: ProjectRepository;
        config: BoardConfig;
    }> = {},
) => {
    const config = deps.config ?? new StaticBoardConfig('source-poller-test-project', '/tmp/code', '/tmp/wt', '/tmp/run');
    const registry = new CardSourceRegistry(sources);
    const cursors = deps.cursors ?? fakeCursorRepo();
    const writer = deps.writer ?? fakeWriter();
    const settings = deps.settings ?? fakeSettingsStore(config, { [config.project]: { 'source-poll-enabled': true } });
    const logger = deps.logger ?? fakeLogger();
    const poller = new SourcePoller(registry, cursors, writer, config, settings, logger, deps.projects);
    return { poller, registry, cursors, writer, settings, logger, config };
};

describe('SourcePoller tick — applying and advancing', () => {
    it('applies every item a source reports, in order, before advancing that cursor', async () => {
        const item1 = { externalId: 'ENG-1', title: 'First', body: 'One', version: 'v1' };
        const item2 = { externalId: 'ENG-2', title: 'Second', body: 'Two', version: 'v1' };
        const source: CardSource = { name: 'linear', changedSince: async () => ({ ok: true, items: [item1, item2], cursor: 'cursor-1' }) };
        const { poller, cursors, writer } = buildPoller([source]);

        await runOneTick(poller);

        expect(writer.apply).toHaveBeenNthCalledWith(1, 'linear', item1);
        expect(writer.apply).toHaveBeenNthCalledWith(2, 'linear', item2);
        expect(cursors.set).toHaveBeenCalledWith('linear', 'cursor-1');
        // Every item applied before the cursor advances — a crash between the two must never lose an
        // item that was already reported.
        const applyOrder = (writer.apply as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
        const setOrder = (cursors.set as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
        expect(Math.max(...applyOrder)).toBeLessThan(setOrder);
    });

    it('the cursor a source is asked with on the second tick is the one the first tick stored', async () => {
        const { source, receivedCursors } = trackingSource('linear', [
            { ok: true, items: [], cursor: 'cursor-1' },
            { ok: true, items: [], cursor: 'cursor-2' },
        ]);
        const { poller } = buildPoller([source]);

        await runOneTick(poller);
        await runOneTick(poller);

        expect(receivedCursors).toEqual([undefined, 'cursor-1']);
    });

    it('a source returning { ok: false } leaves its cursor exactly as it was, and a second source in the same tick is still polled', async () => {
        const refusing: CardSource = { name: 'linear', changedSince: async () => ({ ok: false, reason: 'upstream 500' }) };
        const succeeding: CardSource = { name: 'github', changedSince: async () => ({ ok: true, items: [], cursor: 'cursor-1' }) };
        const { poller, cursors } = buildPoller([refusing, succeeding]);
        await cursors.set('linear', 'cursor-before');

        await runOneTick(poller);

        expect(await cursors.get('linear')).toBe('cursor-before');
        expect(await cursors.get('github')).toBe('cursor-1');
    });

    it('a source that throws does not stop the other sources, and does not stop the loop', async () => {
        const throwing: CardSource = {
            name: 'linear',
            changedSince: async () => {
                throw new Error('network is on fire');
            },
        };
        const succeeding: CardSource = { name: 'github', changedSince: async () => ({ ok: true, items: [], cursor: 'cursor-1' }) };
        const { poller, cursors, logger } = buildPoller([throwing, succeeding]);

        await expect(runOneTick(poller)).resolves.toBeUndefined();

        expect(await cursors.get('github')).toBe('cursor-1');
        expect(logger.error).toHaveBeenCalled();
    });

    it('a tick with SOURCE_POLL_ENABLED false polls nothing', async () => {
        const changedSince = vi.fn(async () => ({ ok: true, items: [], cursor: 'cursor-1' }));
        const source: CardSource = { name: 'linear', changedSince };
        const config = new StaticBoardConfig('source-poller-disabled-project', '/tmp/code', '/tmp/wt', '/tmp/run');
        const settings = fakeSettingsStore(config, { [config.project]: { 'source-poll-enabled': false } });
        const { poller, cursors, writer } = buildPoller([source], { config, settings });

        await runOneTick(poller);

        expect(changedSince).not.toHaveBeenCalled();
        expect(writer.apply).not.toHaveBeenCalled();
        expect(cursors.set).not.toHaveBeenCalled();
    });

    it('an empty registry (no source registered yet — [[0199]]) performs no write', async () => {
        const { poller, writer, cursors } = buildPoller([]);

        await expect(runOneTick(poller)).resolves.toBeUndefined();

        expect(writer.apply).not.toHaveBeenCalled();
        expect(cursors.set).not.toHaveBeenCalled();
    });

    it('logs and swallows a failure listing registered projects instead of throwing', async () => {
        const config = new StaticBoardConfig('source-poller-test-project', '/tmp/code', '/tmp/wt', '/tmp/run');
        const boom = new Error('database is on fire');
        const projects = { list: vi.fn(async () => Promise.reject(boom)) } as unknown as ProjectRepository;
        const changedSince = vi.fn(async () => ({ ok: true, items: [], cursor: 'cursor-1' }));
        const { poller, logger } = buildPoller([{ name: 'linear', changedSince }], { config, projects });

        await expect(runOneTick(poller)).resolves.toBeUndefined();

        expect(changedSince).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(boom);
    });
});

describe('SourcePoller tick — multiple registered projects', () => {
    const projectRow = (name: string): ProjectRow => ({
        name,
        codeRoot: `/tmp/${name}/code`,
        worktreeRoot: `/tmp/${name}/worktrees`,
        runRoot: `/tmp/${name}/run`,
    });

    it('asks SOURCE_POLL_ENABLED per project, polling only the project where it is on', async () => {
        const rows = [projectRow('alpha'), projectRow('beta')];
        const config = new ProjectScopedBoardConfig('alpha');
        const projects = { list: vi.fn(async () => rows) } as unknown as ProjectRepository;
        const changedSince = vi.fn(async () => ({ ok: true, items: [], cursor: 'cursor-1' }));
        const settings = fakeSettingsStore(config, { alpha: { 'source-poll-enabled': true }, beta: { 'source-poll-enabled': false } });
        const { poller } = buildPoller([{ name: 'linear', changedSince }], { config, projects, settings });

        await runOneTick(poller);

        expect(projects.list).toHaveBeenCalledTimes(1);
        expect(changedSince).toHaveBeenCalledTimes(1);
    });

    it('logs and skips a project whose own tick throws, without stopping the walk over the other registered projects', async () => {
        const rows = [projectRow('alpha'), projectRow('beta')];
        const config = new ProjectScopedBoardConfig('alpha');
        const projects = { list: vi.fn(async () => rows) } as unknown as ProjectRepository;
        const boom = new Error('beta settings unreachable');
        const changedSince = vi.fn(async () => ({ ok: true, items: [], cursor: 'cursor-1' }));
        const settings = {
            get: vi.fn(async (definition: { key: string; defaultValue: unknown }) => {
                if (config.project === 'beta') throw boom;
                return definition.key === 'source-poll-enabled' ? true : definition.defaultValue;
            }),
            set: vi.fn(async () => undefined),
        } as unknown as SettingsStore;
        const { poller, logger } = buildPoller([{ name: 'linear', changedSince }], { config, projects, settings });

        await expect(runOneTick(poller)).resolves.toBeUndefined();

        expect(changedSince).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(boom);
    });
});

describe('SourcePoller start/stop', () => {
    afterEach(async () => {
        // Belt and braces: abort anything a test left running so it cannot bleed into the next one.
        for (const entry of [...pending]) entry.resolve();
    });

    it('start() is idempotent: a second call while already running does not start a second loop', async () => {
        const { poller } = buildPoller([]);

        poller.start();
        poller.start();

        await vi.waitFor(() => expect(pending).toHaveLength(1));

        await poller.stop();
    });

    it('stop() is safe to call when the poller was never started', async () => {
        const { poller } = buildPoller([]);

        await expect(poller.stop()).resolves.toBeUndefined();
    });

    it('ticks through the real public start()/stop() surface once the interval elapses, using SOURCE_POLL_INTERVAL_MS', async () => {
        const changedSince = vi.fn(async () => ({ ok: true, items: [], cursor: 'cursor-1' }));
        const { poller, cursors } = buildPoller([{ name: 'linear', changedSince }]);

        poller.start();
        await vi.waitFor(() =>
            expect(delayMock).toHaveBeenCalledWith(SOURCE_POLL_INTERVAL_MS_DEFAULT, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) })),
        );
        releaseTick();

        await vi.waitFor(() => expect(changedSince).toHaveBeenCalledTimes(1));
        expect(cursors.set).toHaveBeenCalledWith('linear', 'cursor-1');

        await poller.stop();
    });

    /**
     * The property `SourcesModule`'s `shutdown` hook depends on: once `stop()` resolves, nothing is
     * still mid-write behind it. Proven by holding a tick open on a `changedSince` that will not
     * resolve until the test says so.
     */
    it('stop() waits out a tick already in flight rather than abandoning it mid-write', async () => {
        let releaseFetch: (() => void) | undefined;
        const changedSince = vi.fn(
            () =>
                new Promise(resolve => {
                    releaseFetch = () => resolve({ ok: true, items: [], cursor: 'cursor-1' });
                }),
        );
        const { poller, cursors } = buildPoller([{ name: 'linear', changedSince } as unknown as CardSource]);

        poller.start();
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        releaseTick();
        await vi.waitFor(() => expect(changedSince).toHaveBeenCalledTimes(1));

        const stopPromise = poller.stop();
        expect(cursors.set).not.toHaveBeenCalled();

        releaseFetch!();
        await stopPromise;

        expect(cursors.set).toHaveBeenCalledWith('linear', 'cursor-1');
    });

    it('applies a changed SOURCE_POLL_INTERVAL_MS to the next wait without a restart', async () => {
        const config = new StaticBoardConfig('source-poller-test-project', '/tmp/code', '/tmp/wt', '/tmp/run');
        // Keyed by `definition.key`, not by call order: unlike `Poller.loop` (`poller.test.ts`'s
        // analogous test), `SourcePoller.tickProject` reads a *second* setting (`SOURCE_POLL_ENABLED`)
        // every tick, so a naive call-ordered `mockResolvedValueOnce` chain would hand the interval's
        // second value to the enabled check instead.
        let intervalReads = 0;
        const settings = {
            get: vi.fn(async (definition: { key: string; defaultValue: unknown }) => {
                if (definition.key !== 'source-poll-interval-ms') return definition.defaultValue;
                intervalReads += 1;
                return intervalReads === 1 ? SOURCE_POLL_INTERVAL_MS_DEFAULT : 5_000;
            }),
            set: vi.fn(async () => undefined),
        } as unknown as SettingsStore;
        const { poller } = buildPoller([], { config, settings });

        poller.start();
        await vi.waitFor(() =>
            expect(delayMock).toHaveBeenCalledWith(SOURCE_POLL_INTERVAL_MS_DEFAULT, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) })),
        );

        releaseTick();
        await vi.waitFor(() => expect(delayMock).toHaveBeenCalledWith(5_000, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) })));

        await poller.stop();
    });
});

/**
 * Card 0198's board-touching acceptance criteria, against a real database — the same idiom
 * `inbound.card.writer.test.ts` uses (`testDb`, `uniqueProject`), driving `tick` directly rather than
 * waiting on the interval.
 */
describe('SourcePoller — end to end against a real board', () => {
    let db: Kysely<DB>;
    beforeAll(() => {
        db = testDb();
    });
    afterAll(async () => {
        await db.destroy();
    });

    const freshPoller = (source: CardSource) => {
        const events = { append: vi.fn(async () => {}) };
        const project = uniqueProject();
        const config = new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run');
        const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        const worktrees = {
            branchName: vi.fn((cardId: string, title: string) => `card/${cardId}-${title}`),
            hasWork: vi.fn(async () => false),
            reclaim: vi.fn(async () => {}),
        };
        const broker = { send: vi.fn(async () => 'job-1'), cancel: vi.fn(async () => {}), getJob: vi.fn(async () => null) };
        const cardJobs = new CardJobs(config, db, broker as unknown as JobBroker);
        const boardWriteService = new BoardWriteService(
            board,
            config,
            worktrees as unknown as WorktreeManager,
            events as unknown as EventLog,
            fakeLogger(),
            cardJobs,
            broker as unknown as JobBroker,
            new RunningCards(),
            undefined as unknown as SettingsStore,
            new StaticStageConfigStore(),
        );
        const writer = new InboundCardWriter(boardWriteService, board, new CacheIdempotencyStore(new PostgresCacheProvider(db)), config, fakeLogger());
        const cursors = new SourceCursorRepository(config, db);
        const registry = new CardSourceRegistry([source]);
        return { board, config, cursors, project, registry, writer };
    };

    it('a source reporting two items lands two cards in parking-lot, both carrying their external ref', async () => {
        const items = [
            { externalId: 'ENG-1', title: 'First', body: 'Body one', version: 'v1' },
            { externalId: 'ENG-2', title: 'Second', body: 'Body two', version: 'v1' },
        ];
        const source: CardSource = { name: 'linear', changedSince: async () => ({ ok: true, items, cursor: 'cursor-1' }) };
        const { board, config, cursors, registry, writer } = freshPoller(source);
        const settings = new SettingsStore(config, db, new AppConfig({ SOURCE_POLL_ENABLED: 'true' }));
        const poller = new SourcePoller(registry, cursors, writer, config, settings, fakeLogger());

        await runOneTick(poller);

        const cards = await board.list();
        expect(cards).toHaveLength(2);
        expect(cards.every(c => c.frontmatter.stage === 'parking-lot')).toBe(true);
        expect(cards.map(c => c.frontmatter.external)).toEqual(expect.arrayContaining([{ linear: 'ENG-1' }, { linear: 'ENG-2' }]));
    });

    it('does not move a card a human has since promoted, when the same external ref is reported again on a later tick', async () => {
        let call = 0;
        const source: CardSource = {
            name: 'linear',
            changedSince: async () => {
                call += 1;
                const title = call === 1 ? 'First' : 'First (updated upstream)';
                // A real source bumps `version` when the item genuinely changes (GitHubIssuesSource
                // uses the issue's `updated_at`); holding it fixed here would make the second delivery a
                // duplicate by card 0197's key, which is the dedup working, not an update being lost.
                return { ok: true, items: [{ externalId: 'ENG-1', title, body: 'Body', version: `v${call}` }], cursor: `cursor-${call}` };
            },
        };
        const { board, config, cursors, registry, writer } = freshPoller(source);
        const settings = new SettingsStore(config, db, new AppConfig({ SOURCE_POLL_ENABLED: 'true' }));
        const poller = new SourcePoller(registry, cursors, writer, config, settings, fakeLogger());

        await runOneTick(poller);
        const [created] = await board.list();
        await board.write(created!.frontmatter.id, 'operator promotes it by hand', card => ({
            ...card,
            frontmatter: { ...card.frontmatter, stage: 'implementing' },
        }));

        await runOneTick(poller);

        const cards = await board.list();
        expect(cards).toHaveLength(1);
        expect(cards[0]!.frontmatter.stage).toBe('implementing');
        expect(cards[0]!.frontmatter.title).toBe('First (updated upstream)');
    });

    it('leaves the cursor untouched on a real refusal, and does not write to the board', async () => {
        const source: CardSource = { name: 'linear', changedSince: async () => ({ ok: false, reason: 'upstream 500' }) };
        const { board, config, cursors, registry, writer } = freshPoller(source);
        await cursors.set('linear', 'cursor-before');
        const settings = new SettingsStore(config, db, new AppConfig({ SOURCE_POLL_ENABLED: 'true' }));
        const poller = new SourcePoller(registry, cursors, writer, config, settings, fakeLogger());

        await runOneTick(poller);

        expect(await cursors.get('linear')).toBe('cursor-before');
        expect(await board.list()).toHaveLength(0);
    });
});
