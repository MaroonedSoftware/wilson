import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { EvalBatchesService } from './eval.batches.service.js';
import { EvalFixtureRepository } from './eval.fixture.repository.js';
import { EvalFixturesService } from './eval.fixtures.service.js';
import { EvalRunRepository } from './eval.run.repository.js';
import { EvalRunner } from './eval.runner.js';

/** Replaying past stage attempts to measure a lane change (PROJECT.md, Evals). */
export const EvalsModule: ServerKitModule = {
    name: 'Evals',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(EvalFixtureRepository).useClass(EvalFixtureRepository).asTransient();
        registry.register(EvalFixturesService).useClass(EvalFixturesService).asTransient();
        registry.register(EvalRunRepository).useClass(EvalRunRepository).asTransient();
        registry.register(EvalRunner).useClass(EvalRunner).asTransient();
        registry.register(EvalBatchesService).useClass(EvalBatchesService).asTransient();
    },
};
