import { Registry } from 'injectkit';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { HealthService } from './health.service.js';

export const HealthModule: ServerKitModule = {
    name: 'Health',
    setup: async (registry: Registry) => {
        registry.register(HealthService).useClass(HealthService).asTransient();
    },
};
