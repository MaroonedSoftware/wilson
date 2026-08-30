import type { Project } from './types/projects.js';
import type { SdkFetch } from './sdk-options.js';
import { parseJson } from './sdk-options.js';

/**
 * generated from [projects.ck](file://./../../../apps/api/data/contracts/projects.ck)
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
}
