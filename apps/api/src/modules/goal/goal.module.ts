import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { GoalRepository } from './goal.repository.js';

/** Goals: a piece of work a chat thread sees through (PROJECT.md, Orchestration). */
export const GoalModule: ServerKitModule = {
    name: 'Goal',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(GoalRepository).useClass(GoalRepository).asTransient();
    },
};
