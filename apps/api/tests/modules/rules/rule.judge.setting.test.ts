import { describe, expect, it, vi } from 'vitest';
import { RuleJudgeSettingService } from '#modules/rules/rule.judge.setting.service.js';
import { DEFAULT_RULE_JUDGE_ROUTE, invalidRuleJudgeRoute, RULE_JUDGE_ROUTE } from '#modules/rules/rule.judge.setting.js';

describe('the rule-judge setting', () => {
    it("defaults to the operator's subscription, which needs no API key", () => {
        expect(RULE_JUDGE_ROUTE.defaultValue.engine).toBe('cli');
    });

    it('takes the engine alone from the environment', () => {
        expect(RULE_JUDGE_ROUTE.parseEnv(' API ')).toEqual({ ...DEFAULT_RULE_JUDGE_ROUTE, engine: 'api' });
        expect(RULE_JUDGE_ROUTE.parseEnv('codex').engine).toBe('cli');
    });

    it.each([
        ['an engine a judge cannot run on', { ...DEFAULT_RULE_JUDGE_ROUTE, engine: 'codex' as never }],
        ['an unknown provider', { ...DEFAULT_RULE_JUDGE_ROUTE, provider: 'nope' as never }],
        ['an empty model', { ...DEFAULT_RULE_JUDGE_ROUTE, model: ' ' }],
    ])('refuses %s', (_name, route) => {
        expect(invalidRuleJudgeRoute(route)).toEqual(expect.any(String));
    });

    it('saves a trimmed model and refuses a bad route with a 400', async () => {
        const settings = { get: vi.fn(), set: vi.fn() };
        const service = new RuleJudgeSettingService(settings as never);

        await expect(service.set({ engine: 'api', provider: 'openai', model: ' gpt ' })).resolves.toMatchObject({ model: 'gpt' });
        expect(settings.set).toHaveBeenCalledWith(RULE_JUDGE_ROUTE, { engine: 'api', provider: 'openai', model: 'gpt' });

        await expect(service.set({ engine: 'api', provider: 'openai', model: '' })).rejects.toMatchObject({ statusCode: 400 });
    });
});
