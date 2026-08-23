import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { ImplementingVerifier } from './implementing.verifier.js';
import { StageDispatcher } from './stage.dispatcher.js';
import { StageVerifierMap } from './stage.verifier.js';

export const StagesModule: ServerKitModule = {
    name: 'Stages',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(ImplementingVerifier).useClass(ImplementingVerifier).asTransient();
        registry
            .register(StageVerifierMap)
            .useFactory(container => {
                const map = new StageVerifierMap();
                map.set('implementing', container.get(ImplementingVerifier));
                return map;
            })
            .asSingleton();
        registry.register(StageDispatcher).useClass(StageDispatcher).asTransient();
    },
};
