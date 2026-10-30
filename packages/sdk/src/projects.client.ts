import type { CreateProjectRequest, DirectoryListing, DirectoryQuery, Project, RepositoryListing, UpdateProjectRequest } from './types/projects.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [projects.ck](../../../apps/api/data/contracts/projects.ck)
 */
export class ProjectsClient {
    constructor(private fetch: SdkFetch) {}

    /**
     * @name List projects
     * @description No project header or `?project=` is required, and none is refused: `ProjectContextRouter`
     * (routes.setup.ts) only refuses a project that is *named and unregistered* — with neither set, it
     * falls back to the daemon's own configured project and calls `next`, the same as every other route
     * on this surface. That catch-all is already correct for a route that lists every project, so no
     * exemption was added for it.
     */
    async listProjects(): Promise<Project[]> {
        const result = await this.fetch(`/api/projects`, { method: 'GET' });
        return await parseJson<Project[]>(result);
    }

    /**
     * @name Register project
     * @description Card 0168. Returns `Project` — the name alone, not the four paths just sent — the same
     * response shape `get` above answers with. Card 0162 withheld those four paths from an
     * unauthenticated read surface on purpose; echoing them back from a write would reverse that
     * quietly, for a caller that already has them. `ProjectsService.create` is where the path
     * validation and the duplicate-name refusal live.
     */
    async registerProject(body: CreateProjectRequest): Promise<Project> {
        const result = await this.fetch(`/api/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<Project>(result);
    }

    /**
     * @name Update project paths
     * @description Not `put`. Fields present in the body are set; fields absent are left as they are — see
     * `UpdateProjectRequest`'s own comment, and `board.ck`'s `PATCH /api/cards/{id}` for the same
     * reasoning stated once and not repeated differently here.
     */
    async updateProjectPaths(name: string, body: UpdateProjectRequest): Promise<Project> {
        const result = await this.fetch(`/api/projects/${encodeURIComponent(name)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<Project>(result);
    }

    /**
     * @name List directories
     * @description Lists folders on the daemon's machine, confined to `PROJECT_BROWSE_ROOT`, or the daemon user's
     * home folder without one: a path outside it (after resolving symlinks) is refused rather than listed. A disclosure weighed the way
     * `CreateProjectRequest`'s comment weighs accepting paths: only an authenticated caller reaches it,
     * and the operator can already read the disk as this user.
     * That confinement is what keeps the listing to the part of the disk a project lives in.
     * Path segment, not a project: `/api/projects/{name}` has no `get`, so there is no clash.
     */
    async listDirectories(query?: DirectoryQuery): Promise<DirectoryListing> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/projects/directories${qs}`, {
            method: 'GET',
        });
        return await parseJson<DirectoryListing>(result);
    }

    /**
     * @name List repositories
     * @description The repositories a project can be registered from, by `owner/name`.
     * Path segment, not a project, as for `/api/projects/directories`.
     */
    async listRepositories(): Promise<RepositoryListing> {
        const result = await this.fetch(`/api/projects/repositories`, { method: 'GET' });
        return await parseJson<RepositoryListing>(result);
    }
}
