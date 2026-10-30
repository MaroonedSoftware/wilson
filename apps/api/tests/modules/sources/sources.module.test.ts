import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import type { Container, Identifier, Registry } from 'injectkit';
import { Kysely } from 'kysely';
import { CacheIdempotencyStore, CacheProvider, IdempotencyStore } from '@maroonedsoftware/cache';
import { BoardModule } from '#modules/board/board.module.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { CardSourceRegistry } from '#modules/sources/card.source.registry.js';
import { GitHubIssuesSource } from '#modules/sources/github.issues.source.js';
import { InboundCardWriter } from '#modules/sources/inbound.card.writer.js';
import { PostgresCacheProvider } from '#modules/sources/postgres.cache.provider.js';
import { SourceCursorRepository } from '#modules/sources/source.cursor.repository.js';
import { SourcePoller } from '#modules/sources/source.poller.js';
import { StatusMirrorPoller } from '#modules/sources/status.mirror.poller.js';
import { SourcesModule } from '#modules/sources/sources.module.js';
import { modules } from '#modules/modules.js';
import type { DB } from '#modules/data/db.js';

/**
 * Card 0203. `container.setup.test.ts` already proves the app's *whole* dependency graph resolves,
 * `InboundCardWriter` included now that `SourcesModule` is part of `modules.ts` — but that test would
 * pass the same way whether `InboundCardWriter` were registered `asSingleton` or `asTransient`, or
 * listed anywhere at all in the module order. This file pins the two things `SourcesModule` itself
 * gets right, at the grain a change to `sources.module.ts` alone could break: what it registers `
 * InboundCardWriter` as, and where `modules.ts` lists it relative to `Board` (this card's Task 3 and
 * `modules.ts`'s own comment on the ordering).
 *
 * The recording registry is `JobsModule.setup`'s own idiom (`jobs.module.test.ts`): `setup` only
 * *describes* registrations, so reading back what it described needs no container build and no
 * database.
 */
/** One registration as `recordingRegistry` below sees it: which `register(...)` call closed it out
 * (`useClass`/`useFactory`/`useInstance`, and what was handed to it), and which lifetime method was
 * called on the returned handle. */
type Registration = { kind: 'useClass' | 'useFactory' | 'useInstance'; impl: unknown; lifetime: string };

/** Records what `register(...)` was called with — `useClass`'s implementation, or `useFactory`'s
 * factory function itself so a test can invoke it against a fake container — and which lifetime
 * method closed it out. Follows `JobsModule.setup`'s own `recordingRegistry` idiom
 * (`jobs.module.test.ts`): `setup` only ever *describes* registrations, so reading them back needs no
 * container build and no database. */
const recordingRegistry = (): { registry: Registry; registrations: Map<unknown, Registration> } => {
    const registrations = new Map<unknown, Registration>();
    const lifetimeHandle = (entry: Registration) => ({
        asSingleton: () => {
            entry.lifetime = 'singleton';
        },
        asTransient: () => {
            entry.lifetime = 'transient';
        },
        asScoped: () => {
            entry.lifetime = 'scoped';
        },
    });
    const registry = {
        register: (id: Identifier<unknown>) => ({
            useClass: (impl: unknown) => {
                const entry: Registration = { kind: 'useClass', impl, lifetime: 'unset' };
                registrations.set(id, entry);
                return lifetimeHandle(entry);
            },
            useFactory: (impl: unknown) => {
                const entry: Registration = { kind: 'useFactory', impl, lifetime: 'unset' };
                registrations.set(id, entry);
                return lifetimeHandle(entry);
            },
            useInstance: (impl: unknown) => {
                const entry: Registration = { kind: 'useInstance', impl, lifetime: 'unset' };
                registrations.set(id, entry);
                return lifetimeHandle(entry);
            },
        }),
    } as unknown as Registry;
    return { registry, registrations };
};

describe('SourcesModule.setup', () => {
    // The `GITHUB_*` keys default to unset here — every test below except card 0199's own
    // gating tests wants the pre-0199 registry-construction behaviour, not a `GitHubIssuesSource`
    // sneaking in because a generic "any key returns something" stub happened to satisfy both.
    const fakeConfig = (env: Record<string, string> = {}): AppConfig =>
        ({ get: (key: string) => env[key] ?? (key.startsWith('GITHUB_') ? '' : 'unused') }) as unknown as AppConfig;
    const fakeContainerWithSettings = (): Container => ({ get: (id: unknown) => (id === SettingsStore ? ({} as SettingsStore) : undefined) }) as unknown as Container;

    it('imports through the GitHub App when no token is set but a key file is named', async () => {
        const { registry, registrations } = recordingRegistry();

        await SourcesModule.setup!(registry, fakeConfig({ GITHUB_REPO: 'acme/app', GITHUB_APP_PRIVATE_KEY_FILE: '/data/secrets/github-app.pem' }));

        const built = (registrations.get(CardSourceRegistry)?.impl as (container: Container) => CardSourceRegistry)(fakeContainerWithSettings());
        expect(built.list().map(source => source.name)).toEqual(['github']);
    });

    it('registers InboundCardWriter as a plain useClass registration', async () => {
        const { registry, registrations } = recordingRegistry();

        await SourcesModule.setup!(registry, fakeConfig());

        expect(registrations.get(InboundCardWriter)?.impl).toBe(InboundCardWriter);
    });

    // `InboundCardWriter` carries no state of its own to protect across calls, but a stray
    // `asSingleton` would still be a wiring drift worth catching by name rather than by a test that
    // happens to notice stale data later — the same reason `JobsModule.setup`'s tests pin `worker`
    // and `policy` on the registration rather than only exercising `JobsModule.start`.
    it('registers it transient, not as a singleton', async () => {
        const { registry, registrations } = recordingRegistry();

        await SourcesModule.setup!(registry, fakeConfig());

        expect(registrations.get(InboundCardWriter)?.lifetime).toBe('transient');
    });

    /**
     * Card 0198. `SourceCursorRepository` follows `CardContextRepository`'s own registration in
     * `ContextModule`: `.useFactory`, because the class needs the process's `Kysely<DB>` pool, not
     * something `useClass`'s reflection can supply on its own.
     */
    it('registers SourceCursorRepository via useFactory, transient', async () => {
        const { registry, registrations } = recordingRegistry();

        await SourcesModule.setup!(registry, fakeConfig());

        const entry = registrations.get(SourceCursorRepository);
        expect(entry?.kind).toBe('useFactory');
        expect(entry?.lifetime).toBe('transient');
    });

    /**
     * Card 0198. `CardSourceRegistry` follows `ContextProviderRegistry`'s own registration: constructed
     * with a plain array, not a set of DI tokens, so `.useFactory` builds it directly. Card 0199: with
     * `GITHUB_TOKEN`/`GITHUB_REPO` unset (this describe block's own default `fakeConfig()`), that array
     * stays empty — exactly [[0196]]'s "stays constructed with an empty list" until something is
     * actually configured to register.
     */
    it('registers CardSourceRegistry via useFactory with an empty source list, as a singleton', async () => {
        const { registry, registrations } = recordingRegistry();

        await SourcesModule.setup!(registry, fakeConfig());

        const entry = registrations.get(CardSourceRegistry);
        expect(entry?.kind).toBe('useFactory');
        expect(entry?.lifetime).toBe('singleton');
        const built = (entry?.impl as (container: Container) => CardSourceRegistry)(fakeContainerWithSettings());
        expect(built.list()).toEqual([]);
    });

    /**
     * Card 0199, this card's own registration gate: `GitHubIssuesSource` is constructed and added to
     * the array `CardSourceRegistry`'s factory builds only when `GITHUB_TOKEN` and `GITHUB_REPO` are
     * both present in the environment at boot — read once in `setup`, not per tick (this card's
     * Constraints, "Registration is all-or-nothing at boot, on the environment").
     */
    it('registers GitHubIssuesSource when GITHUB_TOKEN and GITHUB_REPO are both set', async () => {
        const { registry, registrations } = recordingRegistry();

        await SourcesModule.setup!(registry, fakeConfig({ GITHUB_TOKEN: 'ghp_tok', GITHUB_REPO: 'octocat/hello-world' }));

        const entry = registrations.get(CardSourceRegistry);
        const built = (entry?.impl as (container: Container) => CardSourceRegistry)(fakeContainerWithSettings());
        const sources = built.list();
        expect(sources).toHaveLength(1);
        expect(sources[0]).toBeInstanceOf(GitHubIssuesSource);
        expect(sources[0]!.name).toBe('github');
    });

    /**
     * Card 0199's acceptance criteria: with `GITHUB_TOKEN` unset, `SourcesModule` registers no source
     * and `CardSourceRegistry.list()` is empty, exactly as today — proven here for each variable
     * missing on its own, not only both together.
     */
    it.each([
        ['GITHUB_TOKEN missing', { GITHUB_REPO: 'octocat/hello-world' }],
        ['GITHUB_REPO missing', { GITHUB_TOKEN: 'ghp_tok' }],
        ['both missing', {}],
    ])('registers no source when %s', async (_label, env) => {
        const { registry, registrations } = recordingRegistry();

        await SourcesModule.setup!(registry, fakeConfig(env));

        const entry = registrations.get(CardSourceRegistry);
        const built = (entry?.impl as (container: Container) => CardSourceRegistry)(fakeContainerWithSettings());
        expect(built.list()).toEqual([]);
    });

    /**
     * Card 0198. `SourcePoller` owns one interval timer for the process — the same reason `Poller` is
     * a singleton in `jobs.module.ts`.
     */
    it('registers SourcePoller as a useClass singleton', async () => {
        const { registry, registrations } = recordingRegistry();

        await SourcesModule.setup!(registry, fakeConfig());

        const entry = registrations.get(SourcePoller);
        expect(entry?.kind).toBe('useClass');
        expect(entry?.impl).toBe(SourcePoller);
        expect(entry?.lifetime).toBe('singleton');
    });

    /**
     * Card 0201. `StatusMirrorPoller` is `.useFactory`, not `.useClass`, for the same reason
     * `SourceCursorRepository`/`CacheProvider` above are: it needs the process's `Kysely<DB>` pool
     * directly (to read `wilson.card_events`), which only a factory can hand it. Still a singleton —
     * it owns its own interval timer for the process, the same reason `SourcePoller` is one.
     */
    it('registers StatusMirrorPoller via useFactory, singleton, built from the resolved collaborators', async () => {
        const { registry, registrations } = recordingRegistry();

        await SourcesModule.setup!(registry, fakeConfig());

        const entry = registrations.get(StatusMirrorPoller);
        expect(entry?.kind).toBe('useFactory');
        expect(entry?.lifetime).toBe('singleton');

        const fakeCollaborators = new Map<unknown, unknown>([
            [CardSourceRegistry, new CardSourceRegistry([])],
            [SourceCursorRepository, {}],
            [Kysely<DB>, {} as unknown as Kysely<DB>],
        ]);
        const fakeContainer = { get: (id: unknown) => fakeCollaborators.get(id) ?? {} } as unknown as Container;
        const built = (entry?.impl as (container: Container) => StatusMirrorPoller)(fakeContainer);
        expect(built).toBeInstanceOf(StatusMirrorPoller);
    });

    it('names itself "Sources"', () => {
        expect(SourcesModule.name).toBe('Sources');
    });

    /**
     * Card 0197, task 4: `SourcesModule` registers the two tokens `InboundCardWriter` now also
     * depends on. `CacheProvider` follows `SourceCursorRepository`'s own `.useFactory` reasoning above
     * — it needs the process's `Kysely<DB>` pool, which only a factory (not `useClass`'s reflection)
     * can hand it — and its factory must build a `PostgresCacheProvider`, this deployment's Postgres
     * stand-in for `@maroonedsoftware/cache`'s only shipped backend.
     */
    it('registers CacheProvider via useFactory, transient, built as a PostgresCacheProvider over the process Kysely<DB> pool', async () => {
        const { registry, registrations } = recordingRegistry();

        await SourcesModule.setup!(registry, fakeConfig());

        const entry = registrations.get(CacheProvider);
        expect(entry?.kind).toBe('useFactory');
        expect(entry?.lifetime).toBe('transient');
        const fakeDb = {} as unknown as Kysely<DB>;
        const fakeContainer = { get: (id: unknown) => (id === Kysely ? fakeDb : undefined) } as unknown as Container;
        const built = (entry?.impl as (container: Container) => CacheProvider)(fakeContainer);
        expect(built).toBeInstanceOf(PostgresCacheProvider);
    });

    /**
     * Card 0197, task 4: `IdempotencyStore` is `.useFactory` too — `@maroonedsoftware/cache`'s own
     * `CacheIdempotencyStore` carries no `@Injectable` decorator from this codebase, so `useClass`'s
     * reflection cannot construct it — and it must be built over the very `CacheProvider` the container
     * resolves, not a fresh one of its own.
     */
    it('registers IdempotencyStore via useFactory, transient, built as a CacheIdempotencyStore over the resolved CacheProvider', async () => {
        const { registry, registrations } = recordingRegistry();

        await SourcesModule.setup!(registry, fakeConfig());

        const entry = registrations.get(IdempotencyStore);
        expect(entry?.kind).toBe('useFactory');
        expect(entry?.lifetime).toBe('transient');
        const fakeCacheProvider = {} as unknown as CacheProvider;
        const fakeContainer = { get: (id: unknown) => (id === CacheProvider ? fakeCacheProvider : undefined) } as unknown as Container;
        const built = (entry?.impl as (container: Container) => IdempotencyStore)(fakeContainer);
        expect(built).toBeInstanceOf(CacheIdempotencyStore);
    });
});

/**
 * Card 0198, task 4: `SourcesModule` gains `start`/`shutdown` hooks resolving `SourcePoller` from the
 * container and calling `start()`/`stop()` — the shape `JobsModule` uses for `JobRunner`.
 * Unconditional, unlike `JobsModule`'s `BoundedCardStageJobRunner.start()`: nothing here asks
 * `SOURCE_POLL_ENABLED` — that setting is `SourcePoller.tickProject`'s own question, per project, on
 * every tick, not a gate on whether the loop runs at all.
 *
 * Card 0201 adds `StatusMirrorPoller` to both hooks the same way, unconditionally too —
 * `STATUS_MIRROR_ENABLED` is `StatusMirrorPoller.tickProject`'s own question, not a gate here either.
 */
describe('SourcesModule start/shutdown', () => {
    const fakeContainer = (
        sourcePoller: { start: () => void; stop: () => Promise<void> },
        statusMirrorPoller: { start: () => void; stop: () => Promise<void> },
    ): Container =>
        ({
            get: (id: unknown) => {
                if (id === SourcePoller) return sourcePoller;
                if (id === StatusMirrorPoller) return statusMirrorPoller;
                return undefined;
            },
        }) as unknown as Container;

    it('start calls SourcePoller.start() and StatusMirrorPoller.start()', async () => {
        const sourcePoller = { start: vi.fn(), stop: vi.fn(async () => {}) };
        const statusMirrorPoller = { start: vi.fn(), stop: vi.fn(async () => {}) };

        await SourcesModule.start!(fakeContainer(sourcePoller, statusMirrorPoller));

        expect(sourcePoller.start).toHaveBeenCalledTimes(1);
        expect(statusMirrorPoller.start).toHaveBeenCalledTimes(1);
    });

    it('shutdown calls and awaits both SourcePoller.stop() and StatusMirrorPoller.stop()', async () => {
        let sourceResolved = false;
        let statusMirrorResolved = false;
        const sourcePoller = {
            start: vi.fn(),
            stop: vi.fn(async () => {
                await Promise.resolve();
                sourceResolved = true;
            }),
        };
        const statusMirrorPoller = {
            start: vi.fn(),
            stop: vi.fn(async () => {
                await Promise.resolve();
                statusMirrorResolved = true;
            }),
        };

        await SourcesModule.shutdown!(fakeContainer(sourcePoller, statusMirrorPoller));

        expect(sourcePoller.stop).toHaveBeenCalledTimes(1);
        expect(statusMirrorPoller.stop).toHaveBeenCalledTimes(1);
        expect(sourceResolved).toBe(true);
        expect(statusMirrorResolved).toBe(true);
    });
});

/**
 * The ordering claim `modules.ts`'s own comment makes for card 0203: Sources is listed right after
 * Board, because `InboundCardWriter` depends on tokens only Board's `setup` registers. A future edit
 * that moves Sources earlier (before Board has registered `BoardWriteService`/`BoardRepository`) would
 * not fail `container.setup.test.ts` — `setup` only *describes* registrations, per that file's own
 * "what this does and does not prove" — so this pins the list order directly instead.
 */
describe('modules.ts ordering', () => {
    it('lists Sources immediately after Board', () => {
        const boardIndex = modules.indexOf(BoardModule);
        const sourcesIndex = modules.indexOf(SourcesModule);

        expect(boardIndex).toBeGreaterThanOrEqual(0);
        expect(sourcesIndex).toBe(boardIndex + 1);
    });
});
