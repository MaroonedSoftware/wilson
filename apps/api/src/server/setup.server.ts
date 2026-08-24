import type { Server } from 'node:http';
import { Settings } from 'luxon';
import { ServerKitServerBuilder, type ServerKitRouterType } from '@maroonedsoftware/koa';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { configNumber, requireConfigString } from '#shared/require.config.js';
import { buildConfig, modules } from '../cli-bootstrap.js';
import { routers } from '../routes/routes.setup.js';
import { setupMiddleware } from './setup.middleware.js';
import { captureBuildHead } from './build.info.js';

/**
 * Boots the HTTP server on the same config and module wiring as the CLI (`buildConfig` and
 * `modules` from `cli-bootstrap.ts`), so the two entrypoints cannot drift into configuring the app
 * differently.
 *
 * Unlike the CLI, `ServerKitServerBuilder.start()` runs the full `setup -> start -> ready ->
 * shutdown` lifecycle, so module `start` hooks run here — that's what starts the JobRunner
 * (`JobsModule.start`). The CLI's bootstrap deliberately skips `start` hooks, which is why `wilson
 * run` starts the runner by hand instead.
 */
export const setupServer = async (): Promise<Server> => {
    const serverBuilder = new ServerKitServerBuilder();
    Settings.defaultZone = 'utc'; // luxon, as fintech does
    const config = await buildConfig();
    // Taken at boot, before anything can serve a request: read later it would report the repo's
    // current HEAD rather than the commit this process is running.
    await captureBuildHead(requireConfigString(config, 'PROJECT_CODE_ROOT'));
    await serverBuilder.setup(config, new ConsoleLogger(), modules);
    serverBuilder.setupMiddleware(setupMiddleware).setupRoutes(routers as ServerKitRouterType[]);
    return await serverBuilder.start(configNumber(config, 'PORT', 13100));
};
