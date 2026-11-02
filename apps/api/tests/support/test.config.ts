import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import { buildConfig } from '#src/cli-bootstrap.js';
import { testDbConnection } from './test.db.js';

/**
 * A fixture config for a test that builds the real container (`ServerKitServerBuilder.setup`),
 * without depending on a developer's `apps/api/.env`.
 *
 * `buildConfig` (`cli-bootstrap.ts`) reads a dotenv *file* — `AppConfigSourceDotenv` — plus
 * `AppConfigResolverEnv`, which only resolves `${env:...}` references already present in a value.
 * Neither reads `process.env` directly, so setting environment variables before calling this would
 * do nothing; a real file, pointed at via `buildConfig`'s `envFile` option, is the only way in.
 *
 * The `DATABASE_*` values are `testDbConnection()`'s, not literals: `BoardModule.setup` connects to
 * read the project's row (`resolveProjectRow`), so a suite whose test database is not on `localhost`
 * gets refused here unless this names the same one `testDb()` does. The rest are never exercised for
 * real: they only have to be present and well-formed so `requireConfigString` does not throw during
 * `setup`.
 */
export const buildTestServerConfig = async (): Promise<AppConfig> => {
    const dir = await mkdtemp(join(tmpdir(), 'wilson-server-config-'));
    const envFile = join(dir, '.env');
    const database = testDbConnection();
    await writeFile(
        envFile,
        [
            `DATABASE_HOST=${database.host}`,
            `DATABASE_PORT=${database.port}`,
            `DATABASE_USER=${database.user}`,
            `DATABASE_PASSWORD=${database.password}`,
            `DATABASE_NAME=${database.database}`,
            'PROJECT_NAME=wilson-test',
            'PROJECT_CODE_ROOT=/tmp/wilson-container-test/code',
            // `AuthenticationModule.setup` generates a session key when none exists. Inside this
            // fixture's own directory, so no test writes to the deployment's secrets directory.
            `AUTH_SESSION_KEY_FILE=${join(dir, 'session.pem')}`,
            `AUTH_ENCRYPTION_KEY_FILE=${join(dir, 'encryption.key')}`,
        ].join('\n'),
        'utf8',
    );
    return buildConfig({ envFile });
};
