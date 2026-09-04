import { describe, expect, it } from 'vitest';
import { STATUS_MIRROR_INTERVAL_MS, STATUS_MIRROR_INTERVAL_MS_DEFAULT } from '#modules/settings/status.mirror.interval.setting.js';
import { SOURCE_POLL_INTERVAL_MS_DEFAULT } from '#modules/settings/source.poll.interval.setting.js';

/**
 * Card 0201. `STATUS_MIRROR_INTERVAL_MS` is the `SettingDefinition` `SettingsStore` resolves for how
 * often `StatusMirrorPoller` ticks — the same shape `SOURCE_POLL_INTERVAL_MS` already proves for the
 * inbound poller's own interval.
 */
describe('STATUS_MIRROR_INTERVAL_MS', () => {
    it('is keyed status-mirror-interval-ms, scoped to the deployment, reads STATUS_MIRROR_INTERVAL_MS, and defaults to STATUS_MIRROR_INTERVAL_MS_DEFAULT', () => {
        expect(STATUS_MIRROR_INTERVAL_MS.key).toBe('status-mirror-interval-ms');
        expect(STATUS_MIRROR_INTERVAL_MS.scope).toBe('deployment');
        expect(STATUS_MIRROR_INTERVAL_MS.envVar).toBe('STATUS_MIRROR_INTERVAL_MS');
        expect(STATUS_MIRROR_INTERVAL_MS.defaultValue).toBe(STATUS_MIRROR_INTERVAL_MS_DEFAULT);
    });

    /** Constraint: this loop is driven by events already in the database, not a blind fetch against
     * GitHub's API, so it can run tighter than the inbound poll's own default. */
    it('defaults tighter than the inbound source-poll interval', () => {
        expect(STATUS_MIRROR_INTERVAL_MS_DEFAULT).toBeLessThan(SOURCE_POLL_INTERVAL_MS_DEFAULT);
    });

    it.each([
        ['60000', 60_000],
        ['5000', 5_000],
        ['12345', 12_345],
    ])('parses the raw env string %j as the number %d', (raw, expected) => {
        expect(STATUS_MIRROR_INTERVAL_MS.parseEnv(raw)).toBe(expected);
    });

    /** Fail-fast posture matching `SOURCE_POLL_INTERVAL_MS`: a typo'd env var must not silently
     * resolve to a plausible-but-wrong interval — it has to throw the moment it is read. */
    it.each([['not-a-number'], ['thirty-thousand'], ['NaN'], ['Infinity']])(
        'throws rather than silently falling back when the environment value %j is not a finite number',
        raw => {
            expect(() => STATUS_MIRROR_INTERVAL_MS.parseEnv(raw)).toThrow(`Invalid STATUS_MIRROR_INTERVAL_MS: "${raw}" is not a number`);
        },
    );
});
