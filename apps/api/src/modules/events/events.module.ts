import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { EventLog } from './event.log.js';

export const EventsModule: ServerKitModule = {
    name: 'Events',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(EventLog).useClass(EventLog).asTransient();
    },
};
