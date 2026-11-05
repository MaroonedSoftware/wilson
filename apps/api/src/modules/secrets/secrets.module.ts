import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { SecretRepository } from './secret.repository.js';
import { SecretsService } from './secrets.service.js';

/** The operator's named secrets (`secrets.ck`), encrypted with `AuthenticationModule`'s `EncryptionProvider`. */
export const SecretsModule: ServerKitModule = {
    name: 'Secrets',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(SecretRepository).useClass(SecretRepository).asTransient();
        registry.register(SecretsService).useClass(SecretsService).asTransient();
    },
};
