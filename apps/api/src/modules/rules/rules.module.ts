import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { PostgresRuleStore, RuleStore } from './rule.store.js';
import { RulesService } from './rules.service.js';

/** A project's checked rules (`rules.ck`): `wilson rules list|add|edit|rm`. */
export const RulesModule: ServerKitModule = {
    name: 'Rules',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(RuleStore).useClass(PostgresRuleStore).asTransient();
        registry.register(RulesService).useClass(RulesService).asTransient();
    },
};
