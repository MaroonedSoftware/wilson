/**
 * One registered project's identity, as far as an HTTP caller needs to know it. `ProjectRow`
 * (project.repository.ts) also carries `codeRoot`, `worktreeRoot` and `runRoot` —
 * filesystem layout of the machine the daemon runs on — which are withheld here: a switcher needs
 * names, and an unauthenticated surface (see `security: none` above) is a reason to return the
 * minimum that serves the consumer, not a licence to expose everything `ProjectRepository.list()`
 * already reads.
 * generated from [Project](file://./../../../../apps/api/data/contracts/projects.ck#L30)
 */
export interface Project {
    name: string;
}

/**
 * Card 0168. The three paths `runner.projects` carries beyond `name` — `BoardModule` seeds them from
 * this same process's own environment on first boot (`resolveProjectRow`, board.module.ts), and
 * registering a second project needs the same three values from somewhere, since nothing else on this
 * machine knows them. (`boardRoot` was a fourth until the board repo went: stage config is a
 * `runner.stage_configs` row now, and a new project gets its first one from `wilson board init`.)
 *
 * Decided 2026-08-31: this endpoint takes them from the caller, which is the opposite of
 * `BoardBootstrapService.init`'s stance — its own doc comment refuses a caller-supplied path because
 * "a request that could name an arbitrary filesystem path would be a remote write primitive, which
 * this is not". That reasoning was weighed and not followed here. The grounds: `security: none`
 * above is justified, on every contract that carries it, by the API binding to 127.0.0.1 with no
 * auth boundary yet (card 0019) — and anything that can already reach this port can already `INSERT`
 * a row into `runner.projects` directly, so accepting paths here grants nothing that is not already
 * granted. No confinement root is added either: that would be new configuration, considered and
 * rejected rather than overlooked. Authenticating the API (card 0019) is what actually settles the
 * question `init` answered one way and this answers the other.
 *
 * Only `isAbsolute` is checked — not existence, writability, or that a board lives there — the same
 * restraint `ClaudeConfigDirSettingService.set`'s contract comment gives: a wrong-but-absolute value
 * is discovered by use, not by a check guessing at what "working" means. `ProjectsService.create`
 * normalises with `resolve()`, as `BoardModule` already does for the seeded row.
 * generated from [CreateProjectRequest](file://./../../../../apps/api/data/contracts/projects.ck#L55)
 */
export interface CreateProjectRequest {
    name: string;
    codeRoot: string;
    worktreeRoot: string;
    runRoot: string;
}

/**
 * Every field optional, unlike `CreateProjectRequest`: this is `patch`, not `put` (see the operation
 * below), so a field present is set and a field absent is left as it is — the same partial-update
 * meaning `board.ck`'s `PATCH /api/cards/{id}` comment gives `EditCardRequest`. There is deliberately
 * no `name` here — `runner.projects.name` is the same value the `project` column carries in every
 * other `runner` table, nothing in the schema has a foreign key to it, and a rename would silently
 * orphan every card, event, version and setting rather than failing. The name lives in the path
 * (`/api/projects/{name}`) and nowhere in any request body on this contract.
 * generated from [UpdateProjectRequest](file://./../../../../apps/api/data/contracts/projects.ck#L69)
 */
export interface UpdateProjectRequest {
    codeRoot?: string;
    worktreeRoot?: string;
    runRoot?: string;
}

/**
 * The query for `GET /api/projects/directories`. A named contract rather than an inline `query:` so
 * the generator honours `?` (see `ListQuery` in board.ck). No `path` means the daemon user's home
 * folder, which is also the furthest up the listing will go.
 * generated from [DirectoryQuery](file://./../../../../apps/api/data/contracts/projects.ck#L78)
 */
export interface DirectoryQuery {
    path?: string;
}

/**
 * One folder on the daemon's machine and the folders directly inside it, for the web app's folder
 * picker when registering a project. A browser cannot supply an absolute path from its own picker,
 * and the paths `CreateProjectRequest` takes are the daemon's, not the browser's, so the daemon is
 * the only thing that can answer "what is in this folder".
 *
 * Names only, and folders only: no files, sizes or permissions. `parent` is absent at the home
 * folder, where browsing stops. Hidden folders are included; hiding them is the picker's choice.
 * generated from [DirectoryListing](file://./../../../../apps/api/data/contracts/projects.ck#L89)
 */
export interface DirectoryListing {
    path: string;
    parent?: string;
    directories: string[];
}
