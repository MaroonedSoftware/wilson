import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { httpError } from '@maroonedsoftware/errors';
import type { GitHubApp } from './github.app.js';
import { asApp, gitFailure, runGit, type GitRunner } from './github.git.js';

export type { GitRunner } from './github.git.js';

const exists = (path: string): Promise<boolean> =>
    stat(path).then(
        () => true,
        (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') return false;
            throw err;
        },
    );

/** The `owner/name` a GitHub remote URL points at, https or ssh, or undefined for any other remote. */
const repositoryOf = (remote: string): string | undefined =>
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(.+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1];

/**
 * Puts a GitHub repository at a folder on the daemon's machine, reading it as the GitHub App.
 *
 * A folder already holding that repository is left alone, without asking GitHub for anything, so a
 * clone made by hand can be registered whether or not an app exists. A folder holding anything else
 * is refused rather than cloned over. A new clone is built beside its destination and renamed in, so
 * a failure leaves nothing a later attempt would mistake for a finished clone.
 */
export class GitHubCloner {
    constructor(
        private readonly app: GitHubApp,
        private readonly git: GitRunner = runGit,
    ) {}

    async clone(repository: string, target: string): Promise<void> {
        if (await exists(target)) {
            const remote = await this.originOf(target);
            if (remote?.toLowerCase() === repository.toLowerCase()) return;
            throw httpError(409).withDetails({ reason: `"${target}" already exists and is not a clone of ${repository}` });
        }

        const token = await this.app.tokenFor(repository);
        const partial = join(dirname(target), `.${randomUUID()}.cloning`);
        await mkdir(dirname(target), { recursive: true });
        try {
            const { args, env } = asApp(token, ['clone', `https://github.com/${repository}.git`, partial]);
            await this.git(args, env);
            await rename(partial, target);
        } catch (err) {
            await rm(partial, { recursive: true, force: true });
            throw httpError(503).withDetails({ reason: `could not clone ${repository}: ${gitFailure(err)}` });
        }
    }

    /** `--git-dir`, not `-C`: a plain folder inside some other repo must not answer with that repo's origin. */
    private async originOf(folder: string): Promise<string | undefined> {
        try {
            const { stdout } = await this.git([`--git-dir=${join(folder, '.git')}`, 'remote', 'get-url', 'origin']);
            return repositoryOf(stdout);
        } catch {
            return undefined;
        }
    }
}
