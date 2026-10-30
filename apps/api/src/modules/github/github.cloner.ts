import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { httpError } from '@maroonedsoftware/errors';
import { Duration } from 'luxon';
import type { GitHubApp } from './github.app.js';

const CLONE_TIMEOUT = Duration.fromObject({ minutes: 10 });

/**
 * Answers git's request for credentials from the environment. The token lives in this one process
 * tree: not in argv, where `ps` would show it, and not in the remote URL, which `clone` would keep
 * in `.git/config` for every later stage to read.
 */
const CREDENTIAL_HELPER = '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$WILSON_GIT_TOKEN"; }; f';

export type GitRunner = (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string }>;

const runGit: GitRunner = (args, env) => promisify(execFile)('git', args, { env: env ?? process.env, timeout: CLONE_TIMEOUT.toMillis() });

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
            await this.git(['-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`, 'clone', `https://github.com/${repository}.git`, partial], {
                ...process.env,
                WILSON_GIT_TOKEN: token,
                GIT_TERMINAL_PROMPT: '0',
            });
            await rename(partial, target);
        } catch (err) {
            await rm(partial, { recursive: true, force: true });
            const stderr = (err as { stderr?: string }).stderr?.trim().split('\n').pop();
            throw httpError(502).withDetails({ reason: `could not clone ${repository}: ${stderr || (err as Error).message}` });
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
