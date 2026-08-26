import { Registry } from 'injectkit';
import { ServerKitModule } from '@maroonedsoftware/koa';
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
    setup: async (registry: Registry) => {
        registry.register(SettingsStore).useClass(SettingsStore).asTransient();
        registry.register(PollerSettingService).useClass(PollerSettingService).asTransient();
    },
};
