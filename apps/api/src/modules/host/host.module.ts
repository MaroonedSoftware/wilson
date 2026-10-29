import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { HostRepository } from './host.repository.js';
import { HostsService } from './hosts.service.js';

/**
 * The host registry: {@link HostRepository} and the {@link HostsService} `/api/hosts` binds to. Plain
 * `useClass` registrations, as `LeaseModule`'s are, since both depend only on ordinary tokens.
 */
export const HostModule: ServerKitModule = {
    name: 'Host',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(HostRepository).useClass(HostRepository).asTransient();
        registry.register(HostsService).useClass(HostsService).asTransient();
    },
};
