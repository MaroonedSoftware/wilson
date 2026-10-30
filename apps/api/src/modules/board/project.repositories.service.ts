import { Injectable } from 'injectkit';
import { GitHubApp } from '#modules/github/github.app.js';
import type { RepositoryListing } from '../../generated/projects.js';

/** `GET /api/projects/repositories`: what the GitHub App can read, to register a project from. */
@Injectable()
export class ProjectRepositoriesService {
    constructor(private readonly app: GitHubApp) {}

    async list(): Promise<RepositoryListing> {
        if (!this.app.configured) return { configured: false, repositories: [] };
        return { configured: true, repositories: await this.app.repositories() };
    }
}
