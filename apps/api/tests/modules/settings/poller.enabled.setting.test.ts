import { describe, expect, it } from 'vitest';
import { POLLER_ENABLED } from '#modules/settings/poller.enabled.setting.js';

/**
 * Card 0106. `POLLER_ENABLED` is the `SettingDefinition` `SettingsStore` resolves for the poller's
 * on/off switch — the identity a database row is keyed by (`key`), the environment variable a fresh
 * database falls back to (`envVar`), and the value nothing has ever configured (`defaultValue`).
 */
describe('POLLER_ENABLED', () => {
    it('is keyed poller-enabled, reads POLLER_ENABLED, and defaults to off', () => {
        expect(POLLER_ENABLED.key).toBe('poller-enabled');
        expect(POLLER_ENABLED.envVar).toBe('POLLER_ENABLED');
        expect(POLLER_ENABLED.defaultValue).toBe(false);
    });

    /**
     * `parseEnv` has to agree with `configBoolean` (`shared/require.config.ts`), the parser every
     * other boolean env var in this codebase goes through — otherwise `POLLER_ENABLED=1` would have
     * meant one thing before this card's database row could exist and a different thing after.
     */
    it.each([
        ['true', true],
        ['1', true],
        ['TRUE', true],
        [' true ', true],
        ['false', false],
        ['0', false],
        ['yes', false],
        ['', false],
        ['unset-looking-garbage', false],
    ])('parses the raw env string %j as %s, identically to configBoolean', (raw, expected) => {
        expect(POLLER_ENABLED.parseEnv(raw)).toBe(expected);
    });
});
