import { describe, expect, it } from 'vitest';
import { SOURCE_POLL_INTERVAL_MS, SOURCE_POLL_INTERVAL_MS_DEFAULT } from '#modules/settings/source.poll.interval.setting.js';
import { POLLER_INTERVAL_MS_DEFAULT } from '#modules/jobs/job.runner.config.js';

/**
 * Card 0198. `SOURCE_POLL_INTERVAL_MS` is the `SettingDefinition` `SettingsStore` resolves for how
 * often `SourcePoller` ticks — the same shape `POLLER_INTERVAL_MS` already proves for the card
 * poller's own interval.
 */
describe('SOURCE_POLL_INTERVAL_MS', () => {
    it('is keyed source-poll-interval-ms, scoped to the deployment, reads SOURCE_POLL_INTERVAL_MS, and defaults to SOURCE_POLL_INTERVAL_MS_DEFAULT', () => {
        expect(SOURCE_POLL_INTERVAL_MS.key).toBe('source-poll-interval-ms');
        expect(SOURCE_POLL_INTERVAL_MS.scope).toBe('deployment');
        expect(SOURCE_POLL_INTERVAL_MS.envVar).toBe('SOURCE_POLL_INTERVAL_MS');
        expect(SOURCE_POLL_INTERVAL_MS.defaultValue).toBe(SOURCE_POLL_INTERVAL_MS_DEFAULT);
    });

    /** Constraint: "Default the interval well above the card poller's 30 seconds." */
    it('defaults well above the card poller interval', () => {
        expect(SOURCE_POLL_INTERVAL_MS_DEFAULT).toBeGreaterThan(POLLER_INTERVAL_MS_DEFAULT);
    });

    it.each([
        ['300000', 300_000],
        ['5000', 5_000],
        ['12345', 12_345],
    ])('parses the raw env string %j as the number %d', (raw, expected) => {
        expect(SOURCE_POLL_INTERVAL_MS.parseEnv(raw)).toBe(expected);
    });

    /**
     * Fail-fast posture matching `POLLER_INTERVAL_MS`: a typo'd env var must not silently resolve to
     * a plausible-but-wrong interval — it has to throw the moment it is read.
     */
    it.each([['not-a-number'], ['thirty-thousand'], ['NaN'], ['Infinity']])(
        'throws rather than silently falling back when the environment value %j is not a finite number',
        raw => {
            expect(() => SOURCE_POLL_INTERVAL_MS.parseEnv(raw)).toThrow(`Invalid SOURCE_POLL_INTERVAL_MS: "${raw}" is not a number`);
        },
    );
});
