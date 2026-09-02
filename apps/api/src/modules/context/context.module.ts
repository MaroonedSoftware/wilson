import { Kysely } from 'kysely';
import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';
import { CardContextRepository } from './card.context.repository.js';
import { ContextProviderRegistry } from './context.provider.registry.js';
import { ContextService } from './context.service.js';
import { UrlContextProvider } from './url.context.provider.js';

/**
 * The context-provider slice's HTTP surface (`context.ck`): `CardContextRepository` (card 0185's
 * table) and `ContextProviderRegistry` (card 0186's seam), joined by `ContextService`.
 *
 * `CardContextRepository` is registered with `.useFactory`, not `.useClass` — see its own doc
 * comment for why the class stays undecorated. `ContextProviderRegistry` is the same: its
 * constructor takes a plain array, not a set of DI tokens, so a factory that builds the one
 * provider registered today (`UrlContextProvider`) is simpler than giving that provider a DI
 * registration of its own that nothing else would ever resolve.
 */
export const ContextModule: ServerKitModule = {
    name: 'Context',
    setup: async (registry: Registry, _: AppConfig) => {
        registry
            .register(CardContextRepository)
            .useFactory(container => new CardContextRepository(container.get(BoardConfig), container.get(Kysely<DB>)))
            .asTransient();
        registry
            .register(ContextProviderRegistry)
            .useFactory(() => new ContextProviderRegistry([new UrlContextProvider()]))
            .asSingleton();
        registry.register(ContextService).useClass(ContextService).asTransient();
    },
};
