import { z } from 'zod';

/**
 * One registered project's identity, as far as an HTTP caller needs to know it. `ProjectRow`
 * (project.repository.ts) also carries `codeRoot`, `worktreeRoot` and `runRoot` —
 * filesystem layout of the machine the daemon runs on — which are withheld here: a switcher needs
 * names, and returning the minimum that serves the consumer is the habit worth keeping even behind
 * authentication, not a licence to expose everything `ProjectRepository.list()` already reads.
 * generated from [Project](../../data/contracts/projects.ck)
 */
export const Project = z.strictObject({
    name: z.string(),
});
export type Project = z.infer<typeof Project>;

/**
 * Card 0168. The three paths `wilson.projects` carries beyond `name` — `BoardModule` seeds them from
 * this same process's own environment on first boot (`resolveProjectRow`, board.module.ts), and
 * registering a second project needs the same three values from somewhere, since nothing else on this
 * machine knows them. (`boardRoot` was a fourth until the board repo went: stage config is a
 * `wilson.stage_configs` row now, and a new project gets its first one from `wilson board init`.)
 *
 * Decided 2026-08-31: this endpoint takes them from the caller, which is the opposite of
 * `BoardBootstrapService.init`'s stance — its own doc comment refuses a caller-supplied path because
 * "a request that could name an arbitrary filesystem path would be a remote write primitive, which
 * this is not". That reasoning was weighed and not followed here. The grounds: this operation
 * needs `wilson.manage`, so only the operator, signed in or through a `manage` key, can name a path,
 * and the operator can already write `wilson.projects` directly. No confinement root is added
 * either: that would be new configuration, considered and rejected rather than overlooked.
 *
 * Only `isAbsolute` is checked — not existence, writability, or that a board lives there — the same
 * restraint `ClaudeConfigDirSettingService.set`'s contract comment gives: a wrong-but-absolute value
 * is discovered by use, not by a check guessing at what "working" means. `ProjectsService.create`
 * normalises with `resolve()`, as `BoardModule` already does for the seeded row.
 * generated from [CreateProjectRequest](../../data/contracts/projects.ck)
 */
export const CreateProjectRequest = z.strictObject({
    name: z.string(),
    codeRoot: z.string().optional().describe('Required without a `repository`, which they otherwise default from.'),
    worktreeRoot: z.string().optional(),
    runRoot: z.string().optional(),
    repository: z
        .string()
        .optional()
        .describe(
            'The GitHub repository the code comes from, as `owner/name`, cloned to `codeRoot` through the\nGitHub App unless a clone of it is already there. Without `codeRoot` that is `<repo>` under\nthe browse root.',
        ),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/**
 * Every field optional, unlike `CreateProjectRequest`: this is `patch`, not `put` (see the operation
 * below), so a field present is set and a field absent is left as it is — the same partial-update
 * meaning `board.ck`'s `PATCH /api/cards/{id}` comment gives `EditCardRequest`. There is deliberately
 * no `name` here — `wilson.projects.name` is the same value the `project` column carries in every
 * other `runner` table, nothing in the schema has a foreign key to it, and a rename would silently
 * orphan every card, event, version and setting rather than failing. The name lives in the path
 * (`/api/projects/{name}`) and nowhere in any request body on this contract.
 * generated from [UpdateProjectRequest](../../data/contracts/projects.ck)
 */
export const UpdateProjectRequest = z.strictObject({
    codeRoot: z.string().optional(),
    worktreeRoot: z.string().optional(),
    runRoot: z.string().optional(),
    repository: z.string().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

/**
 * The query for `GET /api/projects/directories`. A named contract rather than an inline `query:` so
 * the generator honours `?` (see `ListQuery` in board.ck). No `path` means the browse root
 * (`PROJECT_BROWSE_ROOT`, or the daemon user's home folder), which is also the furthest up the
 * listing will go.
 * generated from [DirectoryQuery](../../data/contracts/projects.ck)
 */
export const DirectoryQuery = z.strictObject({
    path: z.string().optional(),
});
export type DirectoryQuery = z.infer<typeof DirectoryQuery>;

/**
 * One folder on the daemon's machine and the folders directly inside it, for the web app's folder
 * picker when registering a project. A browser cannot supply an absolute path from its own picker,
 * and the paths `CreateProjectRequest` takes are the daemon's, not the browser's, so the daemon is
 * the only thing that can answer "what is in this folder".
 *
 * Names only, and folders only: no files, sizes or permissions. `parent` is absent at the browse
 * root, where browsing stops. Hidden folders are included; hiding them is the picker's choice.
 * generated from [DirectoryListing](../../data/contracts/projects.ck)
 */
export const DirectoryListing = z.strictObject({
    path: z.string(),
    parent: z.string().optional(),
    directories: z.array(z.string()),
});
export type DirectoryListing = z.infer<typeof DirectoryListing>;

/**
 * One repository the GitHub App can read, across every org that installed it.
 * generated from [GitHubRepository](../../data/contracts/projects.ck)
 */
export const GitHubRepository = z.strictObject({
    fullName: z.string(),
    private: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    defaultBranch: z.string(),
});
export type GitHubRepository = z.infer<typeof GitHubRepository>;

/**
 * `configured` is false on a deployment with no GitHub App, which is a fine way to run and not a
 * failure, so a caller can tell "none set up" from "none installed" without parsing a refusal.
 * generated from [RepositoryListing](../../data/contracts/projects.ck)
 */
export const RepositoryListing = z.strictObject({
    configured: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    repositories: z.array(GitHubRepository),
});
export type RepositoryListing = z.infer<typeof RepositoryListing>;
