import { isAbsolute, resolve } from 'node:path';
import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { ProjectRepository, type ProjectRow } from './project.repository.js';
import type { CreateProjectRequest, Project, UpdateProjectRequest } from '../../generated/projects.js';

/**
 * The deployment's project-registry read surface — the service the generated `/api/projects`
 * router binds to. Card 0148 gave the deployment a project registry and `ProjectRepository.list()`
 * reads it, but nothing exposed it over HTTP until card 0162 added this: the one thing a project
 * switcher (card 0154) must know before it can offer anything. Card 0168 added the two writes
 * beside it: registering a project, and correcting its paths.
 *
 * `list` maps each row down to its `name` alone. `ProjectRow` also carries `boardRoot`, `codeRoot`,
 * `worktreeRoot` and `runRoot` — filesystem layout of the machine the daemon runs on, of no use to
 * a switcher — and this API has no auth boundary yet (card 0019), which is a reason to expose less
 * by default, not a licence to expose everything `ProjectRepository.list()` already reads. `create`
 * and `update` echo the same bare `Project` back for the same reason: a write response is not a
 * licence to disclose more than the read surface already withholds. See `projects.ck` for the
 * fuller argument on why these two writes accept filesystem paths from the caller at all, despite
 * `BoardBootstrapService.init` refusing to.
 */
@Injectable()
export class ProjectsService {
    constructor(private readonly projects: ProjectRepository) {}

    async list(): Promise<Project[]> {
        const rows = await this.projects.list();
        return rows.map(row => ({ name: row.name }));
    }

    /** Register a project. Refuses a taken name with 409, and any non-absolute path with 400. */
    async create(request: CreateProjectRequest): Promise<Project> {
        const { name } = request;
        const paths: Omit<ProjectRow, 'name'> = {
            boardRoot: requireAbsolutePath('boardRoot', request.boardRoot),
            codeRoot: requireAbsolutePath('codeRoot', request.codeRoot),
            worktreeRoot: requireAbsolutePath('worktreeRoot', request.worktreeRoot),
            runRoot: requireAbsolutePath('runRoot', request.runRoot),
        };

        if (await this.projects.find(name)) {
            throw httpError(409).withDetails({ reason: `project "${name}" is already registered` });
        }

        await this.projects.create({ name, ...paths });
        return { name };
    }

    /**
     * Correct whichever of the four paths `request` names, for an already-registered project.
     * `name` is not a field of `request` — it is immutable, and lives only in the path (see
     * `projects.ck`). Refuses an unregistered name with 404, and any path present but not absolute
     * with 400.
     */
    async update(name: string, request: UpdateProjectRequest): Promise<Project> {
        const patch: Partial<Omit<ProjectRow, 'name'>> = {};
        if (request.boardRoot !== undefined) patch.boardRoot = requireAbsolutePath('boardRoot', request.boardRoot);
        if (request.codeRoot !== undefined) patch.codeRoot = requireAbsolutePath('codeRoot', request.codeRoot);
        if (request.worktreeRoot !== undefined) patch.worktreeRoot = requireAbsolutePath('worktreeRoot', request.worktreeRoot);
        if (request.runRoot !== undefined) patch.runRoot = requireAbsolutePath('runRoot', request.runRoot);

        const matched = await this.projects.update(name, patch);
        if (!matched) {
            throw httpError(404).withDetails({ reason: `project "${name}" is not registered` });
        }
        return { name };
    }
}

/**
 * Validate that `value` is an absolute path and normalise it with `resolve()`, as `BoardModule`
 * already does for the environment-seeded row. Nothing else about the path is checked — whether it
 * exists, is writable, or holds what the runner needs is discovered by use, not by a check guessing
 * at what "working" means (`ClaudeConfigDirSettingService.set` follows the same restraint).
 */
const requireAbsolutePath = (field: string, value: string): string => {
    if (!isAbsolute(value)) {
        throw httpError(400).withDetails({ reason: `${field} must be an absolute path, got "${value}"` });
    }
    return resolve(value);
};
