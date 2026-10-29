import type { Server } from 'node:http';
import { Settings } from 'luxon';
import { ServerKitServerBuilder, type ServerKitRouterType } from '@maroonedsoftware/koa';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { KyselyPool } from '@maroonedsoftware/kysely';
import { startCardFeedListener } from '#modules/feed/card.feed.listener.js';
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
    const logger = new ConsoleLogger();
    const container = await serverBuilder.setup(config, logger, modules);
    // Bridges Postgres NOTIFY (issued by `EventLog.append`, from this process's own job runner or
    // a separate `wilson` CLI invocation) onto the in-process card feed `/api/feed` streams from.
    await startCardFeedListener(container.get(KyselyPool), logger, serverBuilder.lifecycleSignal);
    // Same signal, threaded one layer further: the LISTEN connection above drains on shutdown, and
    // this is what makes the `/api/feed` streams hanging off it do the same instead of holding the
    // socket open until the force-close grace period.
    serverBuilder.setupMiddleware(setupMiddleware(config)).setupRoutes(routers(serverBuilder.lifecycleSignal) as ServerKitRouterType[]);
    return await serverBuilder.start(configNumber(config, 'PORT', 13100));
};
