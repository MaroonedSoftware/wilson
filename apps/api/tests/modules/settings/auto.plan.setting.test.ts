import { describe, expect, it } from 'vitest';
import { AUTO_PLAN_ENABLED } from '#modules/settings/auto.plan.setting.js';

describe('AUTO_PLAN_ENABLED', () => {
    it('is keyed auto-plan-enabled, reads AUTO_PLAN_ENABLED, defaults to off, and is project-scoped', () => {
        expect(AUTO_PLAN_ENABLED.key).toBe('auto-plan-enabled');
        expect(AUTO_PLAN_ENABLED.envVar).toBe('AUTO_PLAN_ENABLED');
        expect(AUTO_PLAN_ENABLED.defaultValue).toBe(false);
        expect(AUTO_PLAN_ENABLED.scope).toBe('project');
    });

    it.each([
        ['true', true],
        ['1', true],
        [' TRUE ', true],
        ['false', false],
        ['yes', false],
        ['', false],
    ])('parses the raw env string %j as %s', (raw, expected) => {
        expect(AUTO_PLAN_ENABLED.parseEnv(raw)).toBe(expected);
    });
});
