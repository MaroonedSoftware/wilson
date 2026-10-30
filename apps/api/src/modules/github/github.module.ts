import { readFile } from 'node:fs/promises';
import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { optionalConfigString } from '#shared/require.config.js';
import { GitHubApp, type GitHubAppCredentials } from './github.app.js';
import { GitHubCloner } from './github.cloner.js';

/**
 * The credentials, if this deployment has both halves. A key file that is not there yet counts as
 * unset rather than failing the boot, since the image names the file before anyone has created an app.
 */
const readCredentials = async (config: AppConfig): Promise<GitHubAppCredentials | undefined> => {
    const appId = optionalConfigString(config, 'GITHUB_APP_ID');
    const keyFile = optionalConfigString(config, 'GITHUB_APP_PRIVATE_KEY_FILE');
    if (!appId || !keyFile) return undefined;

    const privateKey = await readFile(keyFile, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
    });
    return privateKey ? { appId, privateKey } : undefined;
};

/** The deployment's GitHub App (`GitHubApp`), one for the process so its tokens are shared, and what clones through it. */
export const GitHubModule: ServerKitModule = {
    name: 'GitHub',
    setup: async (registry: Registry, config: AppConfig) => {
        const credentials = await readCredentials(config);
        registry
            .register(GitHubApp)
            .useFactory(() => new GitHubApp(credentials))
            .asSingleton();
        registry
            .register(GitHubCloner)
            .useFactory(container => new GitHubCloner(container.get(GitHubApp)))
            .asSingleton();
    },
};
