import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { LearningsService } from './learnings.service.js';
import { LearningsStore, PostgresLearningsStore } from './learnings.store.js';

/**
 * The human-approved learnings document's surface (`learnings.ck`, card 0239): `wilson learnings
 * show|edit|set|versions`. `LearningsStore` is registered the same way `StageConfigStore` is in
 * `StagesModule` — through the abstract token, so a test can swap in `StaticLearningsStore` without
 * touching this module.
 */
export const LearningsModule: ServerKitModule = {
    name: 'Learnings',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(LearningsStore).useClass(PostgresLearningsStore).asTransient();
        registry.register(LearningsService).useClass(LearningsService).asTransient();
    },
};
