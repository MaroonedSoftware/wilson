import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { EvalFixtureRepository } from './eval.fixture.repository.js';
import { EvalFixturesService } from './eval.fixtures.service.js';

/** Replaying past stage attempts to measure a lane change (PROJECT.md, Evals). */
export const EvalsModule: ServerKitModule = {
    name: 'Evals',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(EvalFixtureRepository).useClass(EvalFixtureRepository).asTransient();
        registry.register(EvalFixturesService).useClass(EvalFixturesService).asTransient();
    },
};
