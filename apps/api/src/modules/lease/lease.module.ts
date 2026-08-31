import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { DevServerPortAllocator } from './dev.server.port.allocator.js';
import { LeaseService } from './lease.service.js';

/**
 * Card 0165, extended by card 0027. Registers {@link LeaseService} the way `SettingsModule`
 * registers `SettingsStore` — a plain `useClass`, since `LeaseService`'s dependencies
 * (`Kysely<DB>`, `BoardRepository`) are both ordinary registered tokens rather than something
 * only a `setup` hook's `AppConfig` argument can supply. {@link DevServerPortAllocator} — card
 * 0027's port-picking logic built on top of `LeaseService` — is registered the same way.
 *
 * Listed before `WorktreeModule` in `modules.ts` so a reader sees `LeaseService` — which
 * `WorktreeManager` now takes a constructor dependency on, to release a card's leases when its
 * worktree is reclaimed — exist before the module that consumes it. `setup` only registers
 * tokens, though, so the actual container resolution does not depend on this order (see
 * `BoardModule`'s identical note about `PlanService`/`WorktreeModule`).
 */
export const LeaseModule: ServerKitModule = {
    name: 'Lease',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(LeaseService).useClass(LeaseService).asTransient();
        registry.register(DevServerPortAllocator).useClass(DevServerPortAllocator).asTransient();
    },
};
