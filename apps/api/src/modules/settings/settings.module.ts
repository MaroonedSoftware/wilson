import { Kysely } from 'kysely';
import { Container, Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';
import { SettingsStore } from './settings.store.js';
import { PollerSettingService } from './poller.setting.service.js';
import { PollerIntervalSettingService } from './poller.interval.setting.service.js';
import { CardStageConcurrencySettingService } from './card.stage.concurrency.setting.service.js';
import { NotifyWebhookSettingService } from './notify.webhook.setting.service.js';

/**
 * Operational settings backed by `runner.settings` — the poller's on/off switch, its interval,
 * `card.stage`'s concurrency (card 0115), and the notify webhook and base URL (card 0107).
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
        registry.register(PollerIntervalSettingService).useClass(PollerIntervalSettingService).asTransient();
        registry.register(CardStageConcurrencySettingService).useClass(CardStageConcurrencySettingService).asTransient();
        registry.register(NotifyWebhookSettingService).useClass(NotifyWebhookSettingService).asTransient();
    },
    // A `runner.settings` row already present before this boot must take effect immediately, the
    // same as `BoundedCardStageJobRunner.start()` applying `POLLER_ENABLED` at startup
    // (jobs.module.ts) — otherwise `BoardConfig.notifyWebhookUrl`/`notifyBaseUrl` would sit at
    // whatever `BoardModule` read from the environment until the next write.
    start: async (container: Container) => {
        await container.get(NotifyWebhookSettingService).applyCurrentValue();
    },
};
