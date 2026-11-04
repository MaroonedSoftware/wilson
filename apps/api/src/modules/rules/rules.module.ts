import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { RuleJudge } from './rule.judge.js';
import { ApiRuleJudgeEngine, CliRuleJudgeEngine, RuleJudgeEngineMap } from './rule.judge.engine.js';
import { RuleJudgeSettingService } from './rule.judge.setting.service.js';
import { PostgresRuleStore, RuleStore } from './rule.store.js';
import { RuleVerdictStore } from './rule.verdict.store.js';
import { RulesService } from './rules.service.js';

/** A project's checked rules (`rules.ck`): `wilson rules list|add|edit|rm`. */
export const RulesModule: ServerKitModule = {
    name: 'Rules',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(RuleStore).useClass(PostgresRuleStore).asTransient();
        registry.register(RulesService).useClass(RulesService).asTransient();
        registry.register(RuleVerdictStore).useClass(RuleVerdictStore).asTransient();
        registry.register(RuleJudgeSettingService).useClass(RuleJudgeSettingService).asTransient();
        registry.register(ApiRuleJudgeEngine).useClass(ApiRuleJudgeEngine).asTransient();
        registry.register(CliRuleJudgeEngine).useClass(CliRuleJudgeEngine).asTransient();
        // Keyed by the `rule-judge` setting's `engine`.
        registry
            .register(RuleJudgeEngineMap)
            .useFactory(container => {
                const map = new RuleJudgeEngineMap();
                map.set('api', container.get(ApiRuleJudgeEngine));
                map.set('cli', container.get(CliRuleJudgeEngine));
                return map;
            })
            .asSingleton();
        registry.register(RuleJudge).useClass(RuleJudge).asTransient();
    },
};
