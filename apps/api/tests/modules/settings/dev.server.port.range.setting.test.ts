import { describe, expect, it } from 'vitest';
import { DEV_SERVER_PORT_RANGE } from '#modules/settings/dev.server.port.range.setting.js';

/**
 * Card 0027. `DEV_SERVER_PORT_RANGE` is the `SettingDefinition` `SettingsStore` resolves for the
 * port range a stage's dev server may be given — deployment-scoped (card 0152's split), unset by
 * default so a fresh deployment behaves exactly as it did before this card, the same shape
 * `CARD_STAGE_CONCURRENCY` (`card.stage.concurrency.setting.test.ts`) already proves for a
 * deployment-scoped setting.
 */
describe('DEV_SERVER_PORT_RANGE', () => {
    it('is keyed dev-server-port-range, reads DEV_SERVER_PORT_RANGE, is deployment-scoped, and defaults to undefined', () => {
        expect(DEV_SERVER_PORT_RANGE.key).toBe('dev-server-port-range');
        expect(DEV_SERVER_PORT_RANGE.envVar).toBe('DEV_SERVER_PORT_RANGE');
        expect(DEV_SERVER_PORT_RANGE.scope).toBe('deployment');
        expect(DEV_SERVER_PORT_RANGE.defaultValue).toBeUndefined();
    });

    it.each([
        ['4000-4100', { start: 4000, end: 4100 }],
        ['1-65535', { start: 1, end: 65535 }],
        ['5000-5000', { start: 5000, end: 5000 }],
        [' 4000-4100 ', { start: 4000, end: 4100 }],
    ])('parses the raw env string %j as %j', (raw, expected) => {
        expect(DEV_SERVER_PORT_RANGE.parseEnv(raw)).toEqual(expected);
    });

    /**
     * Fail-fast posture matching `CARD_STAGE_CONCURRENCY.parseEnv`: a malformed or out-of-bounds
     * range must not silently resolve to something plausible-but-wrong — two stages could then
     * collide on a port outside the operator's intended range, exactly the bug this card exists to
     * prevent.
     */
    it.each([
        ['not-a-range'],
        ['4000'],
        ['4000-'],
        ['-4100'],
        ['4000-4100-4200'],
        ['4100-4000'], // start > end
        ['0-100'], // below MIN_PORT
        ['4000-70000'], // above MAX_PORT
    ])('throws rather than silently falling back when the environment value %j is invalid', raw => {
        expect(() => DEV_SERVER_PORT_RANGE.parseEnv(raw)).toThrow(/Invalid DEV_SERVER_PORT_RANGE/);
    });
});
