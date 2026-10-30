import { Injectable } from 'injectkit';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { GitHubApp } from '#modules/github/github.app.js';
import type { ExecutionHost } from './execution.host.js';

/** How long the check that a clone is already there may take. */
const CHECK_TIMEOUT_MS = 30_000;

/**
 * Puts a project's clone on a host that can make its own, so a machine needs no project on it ahead
 * of time. The clone happens on the host, with a token for that one repository from the GitHub App,
 * since a large repository's history does not fit through a worker connection as a bundle. Commits
 * Wilson holds and GitHub does not still reach the host the usual way, as a bundle of just those.
 *
 * A clone already there is left alone, without asking GitHub for anything.
 */
@Injectable()
export class ProjectClones {
    constructor(
        private readonly projects: ProjectRepository,
        private readonly app: GitHubApp,
    ) {}

    /** Make sure `codeRoot` on `host` is a clone. Rejects, with a reason, when one cannot be made. */
    async ensure(host: ExecutionHost, project: string, codeRoot: string): Promise<void> {
        if (!host.cloneRepository) return;
        const cloned = await host.exec('git', ['-C', codeRoot, 'rev-parse', '--git-dir'], { cwd: '/', env: {}, timeoutMs: CHECK_TIMEOUT_MS }).then(
            () => true,
            () => false,
        );
        if (cloned) return;

        const repository = (await this.projects.find(project))?.repository;
        if (!repository) throw new Error(`${codeRoot} is not a clone, and project "${project}" has no GitHub repository to make one from`);
        await host.cloneRepository(`https://github.com/${repository}.git`, codeRoot, await this.app.tokenFor(repository));
    }
}
