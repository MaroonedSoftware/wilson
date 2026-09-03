import { Kysely } from 'kysely';
import { Container, Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';
import { CardSourceRegistry } from './card.source.registry.js';
import { InboundCardWriter } from './inbound.card.writer.js';
import { SourceCursorRepository } from './source.cursor.repository.js';
import { SourcePoller } from './source.poller.js';

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
 * Listed after `Board` in `modules.ts` for a reader tracing the dependency the same direction the
 * list reads — `setup` only registers tokens, so the actual container resolution does not depend on
 * this order (see `BoardModule`'s own note on the same point).
 */
export const SourcesModule: ServerKitModule = {
    name: 'Sources',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(InboundCardWriter).useClass(InboundCardWriter).asTransient();
        registry
            .register(SourceCursorRepository)
            .useFactory(container => new SourceCursorRepository(container.get(BoardConfig), container.get(Kysely<DB>)))
            .asTransient();
        registry
            .register(CardSourceRegistry)
            .useFactory(() => new CardSourceRegistry([]))
            .asSingleton();
        registry.register(SourcePoller).useClass(SourcePoller).asSingleton();
    },
    // Unconditional, unlike `JobsModule`'s `BoundedCardStageJobRunner.start()`: `SOURCE_POLL_ENABLED`
    // is asked by `SourcePoller.tickProject` itself, per project, on every tick — not here — so this
    // loop always runs once the process starts, exactly as `SourcePoller`'s own doc explains.
    start: async (container: Container) => {
        container.get(SourcePoller).start();
    },
    // Waits out whatever tick is in flight before the pool `SourceCursorRepository` and
    // `InboundCardWriter` both write through (Data) tears down underneath it — `Poller.stop()`'s own
    // contract, mirrored here.
    shutdown: async (container: Container) => {
        await container.get(SourcePoller).stop();
    },
};
