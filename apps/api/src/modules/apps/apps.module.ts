import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { AppsRepository } from './apps.repository.js';
import { AppsService } from './apps.service.js';

/** The installed operator apps' surface (`apps.ck`). */
export const AppsModule: ServerKitModule = {
    name: 'Apps',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(AppsRepository).useClass(AppsRepository).asTransient();
        registry.register(AppsService).useClass(AppsService).asTransient();
    },
};
