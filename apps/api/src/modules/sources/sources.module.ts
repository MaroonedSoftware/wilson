import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { InboundCardWriter } from './inbound.card.writer.js';

/**
 * Card 0203. Registers `InboundCardWriter`, a plain `useClass` like `LeaseModule` registers
 * `LeaseService`: its two dependencies, `BoardWriteService` and `BoardRepository`, are both ordinary
 * registered tokens rather than something only a `setup` hook's `AppConfig` argument can supply.
 *
 * Listed after `Board` in `modules.ts` for a reader tracing the dependency the same direction the
 * list reads — `setup` only registers tokens, so the actual container resolution does not depend on
 * this order (see `BoardModule`'s own note on the same point). Nothing resolves `InboundCardWriter`
 * yet: the poll ([[0198]]) is a later card, and a seam with no consumer is this card's intended end
 * state (its Constraints).
 */
export const SourcesModule: ServerKitModule = {
    name: 'Sources',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(InboundCardWriter).useClass(InboundCardWriter).asTransient();
    },
};
