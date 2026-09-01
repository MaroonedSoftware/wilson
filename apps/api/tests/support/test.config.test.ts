import { describe, expect, it } from 'vitest';
import { configNumber, requireConfigString } from '#shared/require.config.js';
import { buildTestServerConfig } from '#tests/support/test.config.js';

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
    it('supplies every key a module setup hook requires, through the real buildConfig/dotenv pipeline', async () => {
        const config = await buildTestServerConfig();

        // DataModule / JobsModule's dbConfig.
        expect(requireConfigString(config, 'DATABASE_HOST')).toBe('localhost');
        expect(configNumber(config, 'DATABASE_PORT')).toBe(15533);
        expect(requireConfigString(config, 'DATABASE_USER')).toBe('postgres');
        expect(requireConfigString(config, 'DATABASE_PASSWORD')).toBe('postgres');
        expect(requireConfigString(config, 'DATABASE_NAME')).toBe('wilson_test');

        // BoardModule's codeRoot.
        expect(requireConfigString(config, 'PROJECT_CODE_ROOT')).toBe('/tmp/wilson-container-test/code');
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
        expect(requireConfigString(first, 'DATABASE_NAME')).toBe('wilson_test');
        expect(requireConfigString(second, 'DATABASE_NAME')).toBe('wilson_test');
    });
});
