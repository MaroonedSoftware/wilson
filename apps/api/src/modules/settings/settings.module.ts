import { Kysely } from 'kysely';
import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';
import { SettingsStore } from './settings.store.js';
import { PollerSettingService } from './poller.setting.service.js';

/**
 * Operational settings backed by `runner.settings` — the poller's on/off switch is the first.
 *
 * Listed before Jobs in `modules.ts` so a reader sees `PollerSettingService` (which needs `Poller`)
 * exist before the module that consumes it — `setup` only registers tokens, though, so the actual
 * container resolution does not depend on this order (see `BoardModule`'s identical note about
 * `PlanService`/`WorktreeModule`).
 */
export const SettingsModule: ServerKitModule = {
    name: 'Settings',
    setup: async (registry: Registry, config: AppConfig) => {
        // `useFactory`, not `useClass`: `SettingsStore` needs the process's `AppConfig` to read each
        // setting's environment fallback, and `AppConfig` is the argument to `setup` — it is not a
        // registered token and never has been, so `useClass` cannot resolve it and the container
        // fails to build with "Missing dependencies for SettingsStore: Object". Every test builds the
        // store directly, so nothing caught this until the server actually booted. `BoardModule`
        // solves the same problem the same way, reading config here and passing it in.
        registry
            .register(SettingsStore)
            .useFactory(c => new SettingsStore(c.get(BoardConfig), c.get(Kysely<DB>), config))
            .asTransient();
        registry.register(PollerSettingService).useClass(PollerSettingService).asTransient();
    },
};
