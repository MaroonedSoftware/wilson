import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { HostConnector } from './host.connector.js';
import { HostPlacer } from './host.placer.js';
import { HostProber } from './host.prober.js';
import { HostRepository } from './host.repository.js';
import { HostsService } from './hosts.service.js';

/**
 * The host registry: {@link HostRepository}, the {@link HostsService} `/api/hosts` binds to, and the
 * {@link HostProber} behind its probe, and the {@link HostPlacer} `StageDispatcher` places stages with. Plain `useClass` registrations, as `LeaseModule`'s are, apart
 * from {@link HostConnector}, whose one parameter is a binary path the container cannot supply.
 */
export const HostModule: ServerKitModule = {
    name: 'Host',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(HostRepository).useClass(HostRepository).asTransient();
        registry.register(HostsService).useClass(HostsService).asTransient();
        registry.register(HostConnector).useInstance(new HostConnector());
        registry.register(HostProber).useClass(HostProber).asTransient();
        registry.register(HostPlacer).useClass(HostPlacer).asTransient();
    },
};
