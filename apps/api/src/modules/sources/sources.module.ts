import { Kysely } from 'kysely';
import { Container, Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { Logger } from '@maroonedsoftware/logger';
import { CacheIdempotencyStore, CacheProvider, IdempotencyStore } from '@maroonedsoftware/cache';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { GitHubApp } from '#modules/github/github.app.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import type { DB } from '#modules/data/db.js';
import { optionalConfigString } from '#shared/require.config.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import type { CardSource } from './card.source.js';
import { CardSourceRegistry } from './card.source.registry.js';
import { GitHubIssuesSource } from './github.issues.source.js';
import { InboundCardWriter } from './inbound.card.writer.js';
import { PostgresCacheProvider } from './postgres.cache.provider.js';
import { SourceCursorRepository } from './source.cursor.repository.js';
import { SourcePoller } from './source.poller.js';
import { StatusMirrorPoller } from './status.mirror.poller.js';

/**
 * Card 0203 registered `InboundCardWriter`, a plain `useClass` like `LeaseModule` registers
 * `LeaseService`: its two dependencies, `BoardWriteService` and `BoardRepository`, are both ordinary
 * registered tokens rather than something only a `setup` hook's `AppConfig` argument can supply.
 *
 * Card 0198 adds the rest of the poll transport: `SourceCursorRepository` (`.useFactory`, the same
 * reason `CardContextRepository` gets one in `ContextModule` — it needs the process's `Kysely<DB>`
 * pool, not something `useClass`'s reflection can supply), `CardSourceRegistry` (`.useFactory`,
 * constructed with an empty array — [[0196]]'s own reasoning, the same `ContextProviderRegistry` gets
 * in `ContextModule` for a plain-array constructor with no DI tokens of its own), and `SourcePoller`
 * itself, `.useClass`, singleton — it owns one interval timer for the process, the same reason
 * `Poller` is a singleton in `jobs.module.ts`.
 *
 * Card 0199 is what finally hands `CardSourceRegistry`'s factory something to construct: `GITHUB_TOKEN`
 * and `GITHUB_REPO` are read once, here, via `optionalConfigString` — not `SettingsStore`, since a
 * `SettingDefinition` resolves per current project and `setup` runs at boot with none current — and
 * closed over by the factory, so `GitHubIssuesSource` is constructed (with the resolved `SettingsStore`
 * for the repo/label it reads on every `changedSince`) only when both are present, exactly once, at
 * boot. Neither unset leaves the registry exactly as empty as [[0196]] shipped it.
 *
 * Card 0197 registers the two tokens `InboundCardWriter` now also depends on, so its own `useClass`
 * registration above needs no change: `CacheProvider` (`.useFactory`, `PostgresCacheProvider` against
 * the process's `Kysely<DB>` pool — the same reason `SourceCursorRepository` gets one) and
 * `IdempotencyStore` (`.useFactory`, `CacheIdempotencyStore` built over that provider — not `useClass`,
 * since it comes from `@maroonedsoftware/cache` and cannot carry this codebase's own DI decorator).
 *
 * Listed after `Board` in `modules.ts` for a reader tracing the dependency the same direction the
 * list reads — `setup` only registers tokens, so the actual container resolution does not depend on
 * this order (see `BoardModule`'s own note on the same point).
 */
export const SourcesModule: ServerKitModule = {
    name: 'Sources',
    setup: async (registry: Registry, config: AppConfig) => {
        registry
            .register(CacheProvider)
            .useFactory(container => new PostgresCacheProvider(container.get(Kysely<DB>)))
            .asTransient();
        registry
            .register(IdempotencyStore)
            .useFactory(container => new CacheIdempotencyStore(container.get(CacheProvider)))
            .asTransient();
        registry.register(InboundCardWriter).useClass(InboundCardWriter).asTransient();
        registry
            .register(SourceCursorRepository)
            .useFactory(container => new SourceCursorRepository(container.get(BoardConfig), container.get(Kysely<DB>)))
            .asTransient();
        // Card 0199: registration is all-or-nothing at boot, on the environment — read once here,
        // in `setup`, and closed over by the factory below, never re-read per tick. Both unset is
        // the deployment's own idiom (`NOTIFY_WEBHOOK_URL`'s "unset turns it off entirely, no
        // warning, no HTTP call"): the registry stays empty exactly as it does today. `GITHUB_REPO`
        // and `GITHUB_LABEL` themselves are `SettingDefinition`s (`GitHubIssuesSource` reads them,
        // scoped per project, fresh on every `changedSince`); only the token and the yes/no
        // decision to register at all come from here.
        const githubToken = optionalConfigString(config, 'GITHUB_TOKEN');
        const githubRepo = optionalConfigString(config, 'GITHUB_REPO');
        registry
            .register(CardSourceRegistry)
            .useFactory(container => {
                const sources: CardSource[] = [];
                const app = container.get(GitHubApp);
                // A token set by hand keeps working: the app need not be installed on that repo.
                const token = githubToken ?? (app.configured ? (repo: string) => app.tokenFor(repo) : undefined);
                if (token && githubRepo) {
                    sources.push(new GitHubIssuesSource(container.get(SettingsStore), token));
                }
                return new CardSourceRegistry(sources);
            })
            .asSingleton();
        registry.register(SourcePoller).useClass(SourcePoller).asSingleton();
        // Card 0201: a third, independent loop — mirroring status outward is a different reason to
        // tick than `SourcePoller`'s importing, so this is its own class and its own registration,
        // never a branch inside `SourcePoller`. `.useFactory`, not `.useClass`: this needs the
        // process's `Kysely<DB>` pool directly (to read `wilson.card_events`, which `modules/events/`
        // is outside this card's "Files in scope" to expose a query for), the same reason
        // `SourceCursorRepository` above gets one instead of a decorator's reflection.
        registry
            .register(StatusMirrorPoller)
            .useFactory(
                container =>
                    new StatusMirrorPoller(
                        container.get(CardSourceRegistry),
                        container.get(SourceCursorRepository),
                        container.get(BoardRepository),
                        container.get(BoardConfig),
                        container.get(SettingsStore),
                        container.get(Kysely<DB>),
                        container.get(Logger),
                        container.get(ProjectRepository),
                    ),
            )
            .asSingleton();
    },
    // Unconditional, unlike `JobsModule`'s `BoundedCardStageJobRunner.start()`: `SOURCE_POLL_ENABLED`/
    // `STATUS_MIRROR_ENABLED` are asked by each poller's own `tickProject`, per project, on every
    // tick — not here — so both loops always run once the process starts, exactly as `SourcePoller`'s
    // own doc explains.
    start: async (container: Container) => {
        container.get(SourcePoller).start();
        container.get(StatusMirrorPoller).start();
    },
    // Waits out whatever tick is in flight before the pool `SourceCursorRepository`,
    // `InboundCardWriter`, and `StatusMirrorPoller` all write through (Data) tears down underneath it
    // — `Poller.stop()`'s own contract, mirrored here.
    shutdown: async (container: Container) => {
        await container.get(SourcePoller).stop();
        await container.get(StatusMirrorPoller).stop();
    },
};
