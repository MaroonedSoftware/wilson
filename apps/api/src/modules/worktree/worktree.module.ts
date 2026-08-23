import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { WorktreeManager } from './worktree.manager.js';

export const WorktreeModule: ServerKitModule = {
    name: 'Worktree',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(WorktreeManager).useClass(WorktreeManager).asTransient();
    },
};
