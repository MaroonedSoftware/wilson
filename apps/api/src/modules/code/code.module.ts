import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { CodeReadRepository } from './code.read.repository.js';
import { CodeService } from './code.service.js';

/** Reading a registered project's committed code (`code.ck`), over HTTP and through the catalog. */
export const CodeModule: ServerKitModule = {
    name: 'Code',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(CodeReadRepository).useClass(CodeReadRepository).asTransient();
        registry.register(CodeService).useClass(CodeService).asTransient();
    },
};
