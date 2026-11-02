import { afterEach, describe, expect, it, vi } from 'vitest';
import { configNumber, requireConfigString } from '#shared/require.config.js';
import { buildTestServerConfig } from '#tests/support/test.config.js';
import { testDbConnection } from '#tests/support/test.db.js';

/**
 * Card 0112 added `buildTestServerConfig` so `container.setup.test.ts` could build the real
 * container without depending on a developer's `apps/api/.env`. That test only exercises the
 * fixture indirectly — a typo'd key, a value read from the wrong place, or a fixture that
 * accidentally starts depending on process state would only surface as the container test failing
 * to build, with no signal about which of the fixture's several config keys was at fault.
 *
 * These test the fixture directly, the same way `test.db.test.ts` tests `uniqueProject` directly:
 * through the same accessors the real modules use to read config (`requireConfigString`,
 * `configNumber`), not by re-implementing what `AppConfig.get` already does.
 */
describe('buildTestServerConfig', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('supplies every key a module setup hook requires, through the real buildConfig/dotenv pipeline', async () => {
        const config = await buildTestServerConfig();

        // DataModule / JobsModule's dbConfig.
        const database = testDbConnection();
        expect(requireConfigString(config, 'DATABASE_HOST')).toBe(database.host);
        expect(configNumber(config, 'DATABASE_PORT')).toBe(database.port);
        expect(requireConfigString(config, 'DATABASE_USER')).toBe(database.user);
        expect(requireConfigString(config, 'DATABASE_PASSWORD')).toBe(database.password);
        expect(requireConfigString(config, 'DATABASE_NAME')).toBe(database.database);

        // BoardModule's codeRoot.
        expect(requireConfigString(config, 'PROJECT_CODE_ROOT')).toBe('/tmp/wilson-container-test/code');
    });

    /**
     * `BoardModule.setup` connects with these values, so a fixture that kept its own would be
     * refused on a deployment whose test database is not on `localhost`, which is what happened to
     * three tests in Tower's container (`ECONNREFUSED 127.0.0.1:15533`).
     */
    it('names the database TEST_DATABASE_* points the suite at', async () => {
        vi.stubEnv('TEST_DATABASE_HOST', '172.17.0.1');
        vi.stubEnv('TEST_DATABASE_PORT', '25533');

        const config = await buildTestServerConfig();

        expect(requireConfigString(config, 'DATABASE_HOST')).toBe('172.17.0.1');
        expect(configNumber(config, 'DATABASE_PORT')).toBe(25533);
    });

    /**
     * `buildTestServerConfig` writes a fresh `.env` into its own `mkdtemp` directory on every call
     * rather than a single fixed path, specifically so more than one caller can use it without
     * racing on the same file. Two files in the same vitest worker both importing this helper (or
     * a future caller that calls it more than once) is exactly that scenario — if this ever
     * regressed to a shared/fixed temp path, concurrent calls would race on creating and reading the
     * same file instead of each getting their own.
     */
    it('gives concurrent callers independent config, not a shared fixture file', async () => {
        const [first, second] = await Promise.all([buildTestServerConfig(), buildTestServerConfig()]);

        expect(first).not.toBe(second);
        expect(requireConfigString(first, 'DATABASE_NAME')).toBe(testDbConnection().database);
        expect(requireConfigString(second, 'DATABASE_NAME')).toBe(testDbConnection().database);
    });
});
