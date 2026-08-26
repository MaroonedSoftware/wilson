import { describe, expect, it } from 'vitest';
import { POLLER_INTERVAL_MS } from '#modules/settings/poller.interval.setting.js';
import { POLLER_INTERVAL_MS_DEFAULT } from '#modules/jobs/job.runner.config.js';

/**
 * Card 0115. `POLLER_INTERVAL_MS` is the `SettingDefinition` `SettingsStore` resolves for how often
 * the poller ticks — the identity a database row is keyed by (`key`), the environment variable a
 * fresh database falls back to (`envVar`), and the value nothing has ever configured (`defaultValue`),
 * the same shape `POLLER_ENABLED` (`poller.enabled.setting.test.ts`) already proves for the first
 * setting in this table.
 */
describe('POLLER_INTERVAL_MS', () => {
    it('is keyed poller-interval-ms, reads POLLER_INTERVAL_MS, and defaults to 30 seconds', () => {
        expect(POLLER_INTERVAL_MS.key).toBe('poller-interval-ms');
        expect(POLLER_INTERVAL_MS.envVar).toBe('POLLER_INTERVAL_MS');
        expect(POLLER_INTERVAL_MS.defaultValue).toBe(POLLER_INTERVAL_MS_DEFAULT);
        expect(POLLER_INTERVAL_MS.defaultValue).toBe(30_000);
    });

    it.each([
        ['30000', 30_000],
        ['5000', 5_000],
        ['300000', 300_000],
        ['12345', 12_345],
    ])('parses the raw env string %j as the number %d', (raw, expected) => {
        expect(POLLER_INTERVAL_MS.parseEnv(raw)).toBe(expected);
    });

    /**
     * Fail-fast posture matching `configNumber` (`shared/require.config.ts`): a typo'd env var must
     * not silently resolve to a plausible-but-wrong interval — it has to throw the moment it is
     * read.
     */
    it.each([['not-a-number'], ['thirty-thousand'], ['NaN'], ['Infinity']])(
        'throws rather than silently falling back when the environment value %j is not a finite number',
        raw => {
            expect(() => POLLER_INTERVAL_MS.parseEnv(raw)).toThrow(`Invalid POLLER_INTERVAL_MS: "${raw}" is not a number`);
        },
    );
});
