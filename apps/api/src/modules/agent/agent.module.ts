import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { ModelRegistry } from './model.registry.js';

export const AgentModule: ServerKitModule = {
    name: 'Agent',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(ModelRegistry).useClass(ModelRegistry).asTransient();
    },
};
