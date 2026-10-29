import { Registry } from 'injectkit';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { WorkerConnections } from './worker.connections.js';

/**
 * The worker connections registry, a singleton so the endpoint that fills it and the probe and
 * placement that read it share one. The endpoint itself is attached to the HTTP server in
 * `setup.server.ts`, since a WebSocket upgrade never reaches Koa's middleware or routes.
 */
export const WorkerModule: ServerKitModule = {
    name: 'Worker',
    setup: async (registry: Registry) => {
        registry.register(WorkerConnections).useInstance(new WorkerConnections());
    },
};
