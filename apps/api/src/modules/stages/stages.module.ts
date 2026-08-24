import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { ImplementingVerifier } from './implementing.verifier.js';
import { ReviewVerifier } from './review.verifier.js';
import { StageDispatcher } from './stage.dispatcher.js';
import { StagesService } from './stages.service.js';
import { ImplementingResultSchema, ReviewResultSchema, StageResultSchemaMap } from './stage.result.js';
import { StageVerifierMap } from './stage.verifier.js';
import { TestingVerifier } from './testing.verifier.js';

export const StagesModule: ServerKitModule = {
    name: 'Stages',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(ImplementingVerifier).useClass(ImplementingVerifier).asTransient();
        registry.register(TestingVerifier).useClass(TestingVerifier).asTransient();
        registry.register(ReviewVerifier).useClass(ReviewVerifier).asTransient();
        registry
            .register(StageVerifierMap)
            .useFactory(container => {
                const map = new StageVerifierMap();
                map.set('implementing', container.get(ImplementingVerifier));
                map.set('testing', container.get(TestingVerifier));
                map.set('review', container.get(ReviewVerifier));
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
                return map;
            })
            .asSingleton();
        registry.register(StageDispatcher).useClass(StageDispatcher).asTransient();
        registry.register(StagesService).useClass(StagesService).asTransient();
    },
};
