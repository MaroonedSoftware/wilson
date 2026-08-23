import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { ApiStageAgent } from './api.stage.agent.js';
import { CliStageAgent } from './cli.stage.agent.js';
import { ModelRegistry } from './model.registry.js';
import { StageAgentMap } from './stage.agent.js';

export const AgentModule: ServerKitModule = {
    name: 'Agent',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(ModelRegistry).useClass(ModelRegistry).asTransient();
        registry.register(ApiStageAgent).useClass(ApiStageAgent).asTransient();
        registry.register(CliStageAgent).useClass(CliStageAgent).asTransient();

        // Keyed by the stage's `adapter`. The two fail independently on purpose: an exhausted API
        // balance stops every `api` stage and leaves `cli` untouched.
        registry
            .register(StageAgentMap)
            .useFactory(container => {
                const map = new StageAgentMap();
                map.set('api', container.get(ApiStageAgent));
                map.set('cli', container.get(CliStageAgent));
                return map;
            })
            .asSingleton();
    },
};
