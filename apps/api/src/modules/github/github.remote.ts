import { httpError } from '@maroonedsoftware/errors';
import type { GitHubApp } from './github.app.js';
import { asApp, gitFailure, runGit, type GitRunner } from './github.git.js';

/** Where a fetched GitHub branch is kept in a project clone: git's own name for origin's copy of it. */
export const githubTrackingRef = (branch: string): string => `refs/remotes/origin/${branch}`;

/** What git prints when a push would lose commits the remote has. */
const REJECTED = /\[rejected\]|non-fast-forward|fetch first/;

/**
 * Moves commits between a project clone and its GitHub repository, as the GitHub App.
 *
 * Every call names the remote by URL rather than trusting the clone's `origin`, so a clone whose
 * origin was changed by hand still pushes to the repository the project was registered with. `urlOf`
 * is a constructor parameter so a test can point it at a local bare repository.
 */
export class GitHubRemote {
    constructor(
        private readonly app: GitHubApp,
        private readonly git: GitRunner = runGit,
        private readonly urlOf: (repository: string) => string = repository => `https://github.com/${repository}.git`,
    ) {}

    /**
     * Fetches `branch` from GitHub into {@link githubTrackingRef} in `codeRoot` and returns the sha it
     * names there. Touches no local branch and no checkout.
     */
    async fetchBranch(codeRoot: string, repository: string, branch: string): Promise<string> {
        const ref = githubTrackingRef(branch);
        await this.run(codeRoot, repository, ['fetch', '--no-tags', this.urlOf(repository), `+refs/heads/${branch}:${ref}`], `fetch ${branch} from`);
        return (await this.git(['-C', codeRoot, 'rev-parse', ref])).stdout.trim();
    }

    /**
     * Pushes `sha` to `branch` on GitHub. Never forces: a branch someone else moved on GitHub is a
     * 409 naming it, not something to write over.
     */
    async push(codeRoot: string, repository: string, sha: string, branch: string): Promise<void> {
        const { args, env } = asApp(await this.app.tokenFor(repository), [
            '-C',
            codeRoot,
            'push',
            '--porcelain',
            this.urlOf(repository),
            `${sha}:refs/heads/${branch}`,
        ]);
        try {
            await this.git(args, env);
        } catch (err) {
            const output = `${(err as { stdout?: string }).stdout ?? ''}\n${(err as { stderr?: string }).stderr ?? ''}`;
            if (REJECTED.test(output)) {
                throw httpError(409).withDetails({ reason: `${branch} on ${repository} has commits this card's branch does not; push refused` });
            }
            throw httpError(503).withDetails({ reason: `could not push ${branch} to ${repository}: ${gitFailure(err)}` });
        }
    }

    private async run(codeRoot: string, repository: string, gitArgs: string[], doing: string): Promise<void> {
        const { args, env } = asApp(await this.app.tokenFor(repository), ['-C', codeRoot, ...gitArgs]);
        try {
            await this.git(args, env);
        } catch (err) {
            throw httpError(503).withDetails({ reason: `could not ${doing} ${repository}: ${gitFailure(err)}` });
        }
    }
}
