import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { ChallengeVerifier } from './challenge.verifier.js';
import { ImplementingVerifier } from './implementing.verifier.js';
import { ReviewVerifier } from './review.verifier.js';
import { ScopeCheckVerifier } from './scope.check.verifier.js';
import { StageConfigService } from './stage.config.service.js';
import { PostgresStageConfigStore, StageConfigStore } from './stage.config.store.js';
import { StageDispatcher } from './stage.dispatcher.js';
import { StagesService } from './stages.service.js';
import { ChallengeResultSchema, ImplementingResultSchema, ReviewResultSchema, ScopeCheckResultSchema, StageResultSchemaMap } from './stage.result.js';
import { StageVerifierMap } from './stage.verifier.js';
import { TestingVerifier } from './testing.verifier.js';

export const StagesModule: ServerKitModule = {
    name: 'Stages',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(ImplementingVerifier).useClass(ImplementingVerifier).asTransient();
        // Card 0261: `TestingVerifier` now takes `EventLog` and `BoardConfig` too, to read and write
        // `test.flaky` events — resolved from the registry by constructor type the same way
        // `ChallengeVerifier`'s own `events`/`config` already are, so `useClass` alone is enough;
        // nothing here has to change to thread them through.
        registry.register(TestingVerifier).useClass(TestingVerifier).asTransient();
        registry.register(ReviewVerifier).useClass(ReviewVerifier).asTransient();
        registry.register(ChallengeVerifier).useClass(ChallengeVerifier).asTransient();
        registry.register(ScopeCheckVerifier).useClass(ScopeCheckVerifier).asTransient();
        registry
            .register(StageVerifierMap)
            .useFactory(container => {
                const map = new StageVerifierMap();
                map.set('implementing', container.get(ImplementingVerifier));
                map.set('testing', container.get(TestingVerifier));
                map.set('review', container.get(ReviewVerifier));
                map.set('challenge', container.get(ChallengeVerifier));
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
                map.set('challenge', ChallengeResultSchema);
                map.set('scope-check', ScopeCheckResultSchema);
                return map;
            })
            .asSingleton();
        // Stage config is a `runner.stage_configs` row, read through this token everywhere
        // `loadStages(boardRoot)` used to read the file — see `StageConfigStore`'s own doc comment.
        registry.register(StageConfigStore).useClass(PostgresStageConfigStore).asTransient();
        registry.register(StageDispatcher).useClass(StageDispatcher).asTransient();
        registry.register(StagesService).useClass(StagesService).asTransient();
        // The document's own surface (`stages.ck`): `wilson stages show|edit|set|versions`.
        registry.register(StageConfigService).useClass(StageConfigService).asTransient();
    },
};
