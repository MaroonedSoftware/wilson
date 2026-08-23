import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppConfigBuilder, AppConfigResolverEnv, AppConfigSourceDotenv, type AppConfig } from '@maroonedsoftware/appconfig';
import { modules } from '#modules/modules.js';

/**
 * The shared bootstrap.
 *
 * The CLI and (from step 6) the server both build their container from the same config and the same
 * module list, so the two entrypoints cannot drift into wiring the app differently.
 */
export const buildConfig = async (options: { envFile?: string } = {}): Promise<AppConfig> => {
    // Resolved relative to this file rather than process.cwd(), so the CLI finds the same .env
    // whatever directory it is invoked from.
    const here = dirname(fileURLToPath(import.meta.url));
    const envFile = options.envFile ?? resolve(here, '../.env');

    return new AppConfigBuilder()
        .addSource(new AppConfigSourceDotenv(envFile, { groupSeparator: '__' }))
        .addResolver(new AppConfigResolverEnv())
        .buildSnapshot();
};

export { modules };
export { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
export { BoardRepository } from '#modules/board/board.repository.js';
export { BoardConfig } from '#modules/board/board.config.js';
export { EventLog } from '#modules/events/event.log.js';
export { loadStages, findStage } from '#modules/stages/stage.config.js';
export { filesInScope } from '#modules/board/card.js';
export type { Card } from '#modules/board/card.js';
