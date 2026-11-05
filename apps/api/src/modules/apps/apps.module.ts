import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { AppApiService } from './app.api.service.js';
import { AppsRepository } from './apps.repository.js';
import { AppsService } from './apps.service.js';

/** The installed operator apps' surface (`apps.ck`), and what they read (`app.api.ck`). */
export const AppsModule: ServerKitModule = {
    name: 'Apps',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(AppsRepository).useClass(AppsRepository).asTransient();
        registry.register(AppsService).useClass(AppsService).asTransient();
        registry.register(AppApiService).useClass(AppApiService).asTransient();
    },
};
