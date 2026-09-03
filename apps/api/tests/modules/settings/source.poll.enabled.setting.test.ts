import { describe, expect, it } from 'vitest';
import { SOURCE_POLL_ENABLED } from '#modules/settings/source.poll.enabled.setting.js';

/**
 * Card 0198. `SOURCE_POLL_ENABLED` is the `SettingDefinition` `SettingsStore` resolves for whether
 * `SourcePoller` imports for one project — the identity a database row is keyed by (`key`), the
 * environment variable a fresh database falls back to (`envVar`), and the value nothing has ever
 * configured (`defaultValue`), the same shape `POLLER_ENABLED` already proves.
 */
describe('SOURCE_POLL_ENABLED', () => {
    it('is keyed source-poll-enabled, scoped per project, reads SOURCE_POLL_ENABLED, and defaults to off', () => {
        expect(SOURCE_POLL_ENABLED.key).toBe('source-poll-enabled');
        expect(SOURCE_POLL_ENABLED.scope).toBe('project');
        expect(SOURCE_POLL_ENABLED.envVar).toBe('SOURCE_POLL_ENABLED');
        expect(SOURCE_POLL_ENABLED.defaultValue).toBe(false);
    });

    /**
     * `parseEnv` has to agree with `POLLER_ENABLED`'s own parser — otherwise `SOURCE_POLL_ENABLED=1`
     * would mean something different from `POLLER_ENABLED=1` for no reason a reader could discover.
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
    ])('parses the raw env string %j as %s', (raw, expected) => {
        expect(SOURCE_POLL_ENABLED.parseEnv(raw)).toBe(expected);
    });
});
