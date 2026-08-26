import { describe, expect, it } from 'vitest';
import { CARD_STAGE_CONCURRENCY } from '#modules/settings/card.stage.concurrency.setting.js';
import { CARD_STAGE_CONCURRENCY_DEFAULT } from '#modules/jobs/job.runner.config.js';

/**
 * Card 0115. `CARD_STAGE_CONCURRENCY` is the `SettingDefinition` `SettingsStore` resolves for how
 * many `card.stage` jobs run at once — the identity a database row is keyed by (`key`), the
 * environment variable a fresh database falls back to (`envVar`), and the value nothing has ever
 * configured (`defaultValue`), the same shape `POLLER_ENABLED` (`poller.enabled.setting.test.ts`)
 * already proves for the first setting in this table.
 */
describe('CARD_STAGE_CONCURRENCY', () => {
    it('is keyed card-stage-concurrency, reads CARD_STAGE_CONCURRENCY, and defaults to 3', () => {
        expect(CARD_STAGE_CONCURRENCY.key).toBe('card-stage-concurrency');
        expect(CARD_STAGE_CONCURRENCY.envVar).toBe('CARD_STAGE_CONCURRENCY');
        expect(CARD_STAGE_CONCURRENCY.defaultValue).toBe(CARD_STAGE_CONCURRENCY_DEFAULT);
        expect(CARD_STAGE_CONCURRENCY.defaultValue).toBe(3);
    });

    it.each([
        ['1', 1],
        ['3', 3],
        ['8', 8],
    ])('parses the raw env string %j as the integer %d', (raw, expected) => {
        expect(CARD_STAGE_CONCURRENCY.parseEnv(raw)).toBe(expected);
    });

    /**
     * Fail-fast posture matching `configNumber` (`shared/require.config.ts`): a typo'd or
     * fractional env var must not silently resolve to a plausible-but-wrong worker count — it has
     * to throw the moment it is read, and it is specifically an *integer* this setting requires,
     * unlike `POLLER_INTERVAL_MS` which only requires finite.
     */
    it.each([['not-a-number'], ['3.5'], ['NaN'], ['Infinity']])(
        'throws rather than silently falling back when the environment value %j is not an integer',
        raw => {
            expect(() => CARD_STAGE_CONCURRENCY.parseEnv(raw)).toThrow(`Invalid CARD_STAGE_CONCURRENCY: "${raw}" is not an integer`);
        },
    );
});
