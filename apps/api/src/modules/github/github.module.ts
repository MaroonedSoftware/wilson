import { readFile } from 'node:fs/promises';
import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { optionalConfigString } from '#shared/require.config.js';
import { GITHUB_APP_ID } from '#modules/settings/github.app.id.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { GitHubApp } from './github.app.js';
import { GitHubCloner } from './github.cloner.js';

/** The key's contents, or undefined while it is not there, which is how a deployment with no app looks. */
const readKey = async (keyFile: string | undefined): Promise<string | undefined> => {
    if (!keyFile) return undefined;
    const key = await readFile(keyFile, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
    });
    return key || undefined;
};

/** The deployment's GitHub App (`GitHubApp`), one for the process so its tokens are shared, and what clones through it. */
export const GitHubModule: ServerKitModule = {
    name: 'GitHub',
    setup: async (registry: Registry, config: AppConfig) => {
        const keyFile = optionalConfigString(config, 'GITHUB_APP_PRIVATE_KEY_FILE');
        registry
            .register(GitHubApp)
            .useFactory(
                container =>
                    new GitHubApp({
                        appId: () => container.get(SettingsStore).get(GITHUB_APP_ID),
                        privateKey: () => readKey(keyFile),
                    }),
            )
            .asSingleton();
        registry
            .register(GitHubCloner)
            .useFactory(container => new GitHubCloner(container.get(GitHubApp)))
            .asSingleton();
    },
};
