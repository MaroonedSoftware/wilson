import { describe, expect, it } from 'vitest';
import { STATUS_MIRROR_ENABLED } from '#modules/settings/status.mirror.enabled.setting.js';

/**
 * Card 0201. `STATUS_MIRROR_ENABLED` is the `SettingDefinition` `SettingsStore` resolves for whether
 * `StatusMirrorPoller` mirrors a card's stage back to its `external` ref for one project — the same
 * shape `SOURCE_POLL_ENABLED` already proves.
 */
describe('STATUS_MIRROR_ENABLED', () => {
    it('is keyed status-mirror-enabled, scoped per project, reads STATUS_MIRROR_ENABLED, and defaults to off', () => {
        expect(STATUS_MIRROR_ENABLED.key).toBe('status-mirror-enabled');
        expect(STATUS_MIRROR_ENABLED.scope).toBe('project');
        expect(STATUS_MIRROR_ENABLED.envVar).toBe('STATUS_MIRROR_ENABLED');
        expect(STATUS_MIRROR_ENABLED.defaultValue).toBe(false);
    });

    /** `parseEnv` has to agree with `SOURCE_POLL_ENABLED`'s own parser — otherwise
     * `STATUS_MIRROR_ENABLED=1` would mean something different for no reason a reader could discover. */
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
        expect(STATUS_MIRROR_ENABLED.parseEnv(raw)).toBe(expected);
    });
});
