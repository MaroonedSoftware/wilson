import { describe, expect, it } from 'vitest';
import { DRY_RUN_ENABLED } from '#modules/settings/dry.run.setting.js';

/**
 * Card 0144. `DRY_RUN_ENABLED` is the `SettingDefinition` `SettingsStore` resolves for the merge
 * pipeline's rehearsal switch — the identity a database row is keyed by (`key`), the environment
 * variable a fresh database falls back to (`envVar`), and the value nothing has ever configured
 * (`defaultValue`).
 *
 * Unlike `POLLER_ENABLED` (`poller.enabled.setting.test.ts`), `defaultValue` here is `true` —
 * PROJECT.md's "ship with dry run on" — so this is the one place in the suite that would catch an
 * accidental flip of the default, in either direction.
 */
describe('DRY_RUN_ENABLED', () => {
    it('is keyed dry-run-enabled, reads DRY_RUN_ENABLED, and defaults to on', () => {
        expect(DRY_RUN_ENABLED.key).toBe('dry-run-enabled');
        expect(DRY_RUN_ENABLED.envVar).toBe('DRY_RUN_ENABLED');
        expect(DRY_RUN_ENABLED.defaultValue).toBe(true);
    });

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
        expect(DRY_RUN_ENABLED.parseEnv(raw)).toBe(expected);
    });
});
