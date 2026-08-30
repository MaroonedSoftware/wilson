import { Injectable } from 'injectkit';
import { ProjectRepository } from './project.repository.js';
import type { Project } from '../../generated/projects.js';

/**
 * The deployment's project-registry read surface — the service the generated `/api/projects`
 * router binds to. Card 0148 gave the deployment a project registry and `ProjectRepository.list()`
 * reads it, but nothing exposed it over HTTP until card 0162 added this: the one thing a project
 * switcher (card 0154) must know before it can offer anything.
 *
 * Maps each row down to its `name` alone. `ProjectRow` also carries `boardRoot`, `codeRoot`,
 * `worktreeRoot` and `runRoot` — filesystem layout of the machine the daemon runs on, of no use to
 * a switcher — and this API has no auth boundary yet (card 0019), which is a reason to expose less
 * by default, not a licence to expose everything `ProjectRepository.list()` already reads.
 */
@Injectable()
export class ProjectsService {
    constructor(private readonly projects: ProjectRepository) {}

    async list(): Promise<Project[]> {
        const rows = await this.projects.list();
        return rows.map(row => ({ name: row.name }));
    }
}
