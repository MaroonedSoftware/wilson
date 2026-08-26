import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { buildConfig } from '#src/cli-bootstrap.js';

/**
 * A fixture config for a test that builds the real container (`ServerKitServerBuilder.setup`),
 * without depending on a developer's `apps/api/.env`.
 *
 * `buildConfig` (`cli-bootstrap.ts`) reads a dotenv *file* — `AppConfigSourceDotenv` — plus
 * `AppConfigResolverEnv`, which only resolves `${env:...}` references already present in a value.
 * Neither reads `process.env` directly, so setting environment variables before calling this would
 * do nothing; a real file, pointed at via `buildConfig`'s `envFile` option, is the only way in.
 *
 * The values below are never exercised for real: every module's `setup` hook reads them to build a
 * config object (a `dbConfig`, a resolved path) but nothing in `ServerKitServerBuilder.setup` opens
 * the database connection or touches the filesystem at either root — see the container test this
 * supports for what does, and does not, get resolved. They only have to be present and well-formed
 * so `requireConfigString` does not throw during `setup`.
 */
export const buildTestServerConfig = async (): Promise<AppConfig> => {
    const dir = await mkdtemp(join(tmpdir(), 'wilson-server-config-'));
    const envFile = join(dir, '.env');
    await writeFile(
        envFile,
        [
            'DATABASE_HOST=localhost',
            'DATABASE_PORT=15533',
            'DATABASE_USER=postgres',
            'DATABASE_PASSWORD=postgres',
            'DATABASE_NAME=wilson_test',
            'PROJECT_NAME=wilson-test',
            'PROJECT_CODE_ROOT=/tmp/wilson-container-test/code',
            'PROJECT_BOARD_ROOT=/tmp/wilson-container-test/board',
        ].join('\n'),
        'utf8',
    );
    return buildConfig({ envFile });
};
