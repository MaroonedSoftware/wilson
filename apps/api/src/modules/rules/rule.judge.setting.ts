import { PROVIDERS, type Provider } from '#modules/agent/model.registry.js';
import type { SettingDefinition } from '#modules/settings/setting.definition.js';

export const RULE_JUDGE_ENGINES = ['api', 'cli'] as const;
export type RuleJudgeEngineName = (typeof RULE_JUDGE_ENGINES)[number];

/** Which engine judges a project's rules, and on what model. */
export interface RuleJudgeRoute {
    engine: RuleJudgeEngineName;
    /** The provider the 'api' engine resolves `model` through (`ModelRegistry`). 'cli' always runs Claude. */
    provider: Provider;
    model: string;
}

export const DEFAULT_RULE_JUDGE_ROUTE: RuleJudgeRoute = { engine: 'cli', provider: 'anthropic', model: 'claude-sonnet-5-5' };

/**
 * The `rule-judge` setting: the judges' own route, apart from any lane's, so a review lane on an engine
 * with no one-shot call (`codex`) still has judges.
 *
 * `scope: 'project'`, like `AUTO_SPLIT_ENABLED`: what a project spends on checking its own rules is a
 * property of that project. 'cli' by default, the operator's subscription, as a chat turn is. 'api'
 * needs a key for `provider` in `apps/api/.env`, and bills per token. Read fresh on every judgement, so
 * saving the row is the whole job.
 *
 * `RULE_JUDGE_ENGINE` in the environment names the engine alone, with the default model.
 */
export const RULE_JUDGE_ROUTE: SettingDefinition<RuleJudgeRoute> = {
    key: 'rule-judge',
    scope: 'project',
    envVar: 'RULE_JUDGE_ENGINE',
    parseEnv: raw => ({ ...DEFAULT_RULE_JUDGE_ROUTE, engine: raw.trim().toLowerCase() === 'api' ? 'api' : 'cli' }),
    defaultValue: DEFAULT_RULE_JUDGE_ROUTE,
};

/** Why `route` cannot be saved, or undefined when it can. */
export const invalidRuleJudgeRoute = (route: RuleJudgeRoute): string | undefined => {
    if (!RULE_JUDGE_ENGINES.includes(route.engine)) return `engine must be one of ${RULE_JUDGE_ENGINES.join(', ')}`;
    if (!PROVIDERS.includes(route.provider)) return `provider must be one of ${PROVIDERS.join(', ')}`;
    if (!route.model.trim()) return 'a model is required';
    return undefined;
};
