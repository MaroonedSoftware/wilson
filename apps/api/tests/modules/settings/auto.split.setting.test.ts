import { describe, expect, it } from 'vitest';
import { AUTO_SPLIT_ENABLED } from '#modules/settings/auto.split.setting.js';

describe('AUTO_SPLIT_ENABLED', () => {
    it('is keyed auto-split-enabled, reads AUTO_SPLIT_ENABLED, defaults to off, and is project-scoped', () => {
        expect(AUTO_SPLIT_ENABLED.key).toBe('auto-split-enabled');
        expect(AUTO_SPLIT_ENABLED.envVar).toBe('AUTO_SPLIT_ENABLED');
        expect(AUTO_SPLIT_ENABLED.defaultValue).toBe(false);
        expect(AUTO_SPLIT_ENABLED.scope).toBe('project');
    });

    it.each([
        ['true', true],
        ['1', true],
        [' TRUE ', true],
        ['false', false],
        ['yes', false],
        ['', false],
    ])('parses the raw env string %j as %s', (raw, expected) => {
        expect(AUTO_SPLIT_ENABLED.parseEnv(raw)).toBe(expected);
    });
});
