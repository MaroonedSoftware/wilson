import { Container, Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { Logger } from '@maroonedsoftware/logger';
import { runAsProject } from '#modules/board/project.context.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { ImplementingVerifier } from './implementing.verifier.js';
import { ReviewVerifier } from './review.verifier.js';
import { ScopeCheckVerifier } from './scope.check.verifier.js';
import { seedStageConfigFromBoardRepo } from './stage.config.seed.js';
import { PostgresStageConfigStore, StageConfigStore } from './stage.config.store.js';
import { StageDispatcher } from './stage.dispatcher.js';
import { StagesService } from './stages.service.js';
import { ImplementingResultSchema, ReviewResultSchema, ScopeCheckResultSchema, StageResultSchemaMap } from './stage.result.js';
import { StageVerifierMap } from './stage.verifier.js';
import { TestingVerifier } from './testing.verifier.js';

export const StagesModule: ServerKitModule = {
    name: 'Stages',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(ImplementingVerifier).useClass(ImplementingVerifier).asTransient();
        registry.register(TestingVerifier).useClass(TestingVerifier).asTransient();
        registry.register(ReviewVerifier).useClass(ReviewVerifier).asTransient();
        registry.register(ScopeCheckVerifier).useClass(ScopeCheckVerifier).asTransient();
        registry
            .register(StageVerifierMap)
            .useFactory(container => {
                const map = new StageVerifierMap();
                map.set('implementing', container.get(ImplementingVerifier));
                map.set('testing', container.get(TestingVerifier));
                map.set('review', container.get(ReviewVerifier));
                map.set('scope-check', container.get(ScopeCheckVerifier));
                return map;
            })
            .asSingleton();
        registry
            .register(StageResultSchemaMap)
            .useFactory(() => {
                const map = new StageResultSchemaMap();
                map.set('implementing', ImplementingResultSchema);
                map.set('testing', ImplementingResultSchema);
                map.set('review', ReviewResultSchema);
                map.set('scope-check', ScopeCheckResultSchema);
                return map;
            })
            .asSingleton();
        // Stage config is a `runner.stage_configs` row, read through this token everywhere
        // `loadStages(boardRoot)` used to read the file — see `StageConfigStore`'s own doc comment.
        registry.register(StageConfigStore).useClass(PostgresStageConfigStore).asTransient();
        registry.register(StageDispatcher).useClass(StageDispatcher).asTransient();
        registry.register(StagesService).useClass(StagesService).asTransient();
    },
    /**
     * Carry each registered project's `config/stages.yaml` into `runner.stage_configs` if it has no
     * row yet — see `seedStageConfigFromBoardRepo`. After `Board` has registered every project's
     * paths (module order in `modules.ts`) and before `Jobs` starts dispatching against the config.
     */
    start: async (container: Container) => {
        const store = container.get(StageConfigStore);
        const logger = container.get(Logger);
        for (const row of await container.get(ProjectRepository).list()) {
            await runAsProject(row.name, () => seedStageConfigFromBoardRepo(store, row, logger));
        }
    },
};
