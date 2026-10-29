import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { optionalConfigString } from '#shared/require.config.js';
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
    setup: async (registry: Registry, config: AppConfig) => {
        registry.register(HostRepository).useClass(HostRepository).asTransient();
        registry.register(HostsService).useClass(HostsService).asTransient();
        // A token of its own, not CLAUDE_CODE_OAUTH_TOKEN: that name in this process's environment
        // would sign the engine on this machine in with it too, in place of the operator's own
        // `claude-config-dir` choice.
        registry.register(HostConnector).useInstance(new HostConnector('ssh', optionalConfigString(config, 'REMOTE_CLAUDE_CODE_OAUTH_TOKEN')));
        registry.register(HostProber).useClass(HostProber).asTransient();
        registry.register(HostPlacer).useClass(HostPlacer).asTransient();
    },
};
