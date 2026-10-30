options {
    services: {
        ProjectsService: "#modules/board/projects.service.js"
        ProjectDirectoriesService: "#modules/board/project.directories.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# Card 0162. The deployment's project registry (card 0148's `wilson.projects`), not any one
# project's board — the same distinction card 0152 drew between project and deployment settings.
# Every operation in `board.ck` describes work *within* one project; this one describes the
# deployment itself, which is why it lives in its own file beside `board.ck` rather than inside it.
# `contractkit.config.json` discovers contracts by glob (`apps/api/data/contracts/**/*.ck`), so
# adding this file needed no configuration change.
#
# Gated (PROJECT.md decision 10): the file's floor is `wilson.manage`, which a signed-in session
# or a `manage` API key satisfies, and every `get` lowers it to `wilson.view`, which any session
# or key does. Anything without a credential gets 401 before a handler runs.
#
# Card 0154 hit this directly: it needed a project switcher, and had no endpoint to ask what
# projects exist. Its own Files in scope (`apps/web/src/**`) put this endpoint out of reach, so it
# lands here instead, as its own in-scope work, for 0154 to consume.

# One registered project's identity, as far as an HTTP caller needs to know it. `ProjectRow`
# (project.repository.ts) also carries `codeRoot`, `worktreeRoot` and `runRoot` —
# filesystem layout of the machine the daemon runs on — which are withheld here: a switcher needs
# names, and returning the minimum that serves the consumer is the habit worth keeping even behind
# authentication, not a licence to expose everything `ProjectRepository.list()` already reads.
contract Project: {
    name: string
}

# Card 0168. The three paths `wilson.projects` carries beyond `name` — `BoardModule` seeds them from
# this same process's own environment on first boot (`resolveProjectRow`, board.module.ts), and
# registering a second project needs the same three values from somewhere, since nothing else on this
# machine knows them. (`boardRoot` was a fourth until the board repo went: stage config is a
# `wilson.stage_configs` row now, and a new project gets its first one from `wilson board init`.)
#
# Decided 2026-08-31: this endpoint takes them from the caller, which is the opposite of
# `BoardBootstrapService.init`'s stance — its own doc comment refuses a caller-supplied path because
# "a request that could name an arbitrary filesystem path would be a remote write primitive, which
# this is not". That reasoning was weighed and not followed here. The grounds: this operation
# needs `wilson.manage`, so only the operator, signed in or through a `manage` key, can name a path,
# and the operator can already write `wilson.projects` directly. No confinement root is added
# either: that would be new configuration, considered and rejected rather than overlooked.
#
# Only `isAbsolute` is checked — not existence, writability, or that a board lives there — the same
# restraint `ClaudeConfigDirSettingService.set`'s contract comment gives: a wrong-but-absolute value
# is discovered by use, not by a check guessing at what "working" means. `ProjectsService.create`
# normalises with `resolve()`, as `BoardModule` already does for the seeded row.
contract CreateProjectRequest: {
    name: string
    # Required without a `repository`, which they otherwise default from.
    codeRoot?: string
    worktreeRoot?: string
    runRoot?: string
    # The GitHub repository the code comes from, as `owner/name`, cloned to `codeRoot` through the
    # GitHub App unless a clone of it is already there. Without `codeRoot` that is `<repo>` under
    # the browse root.
    repository?: string
}

# Every field optional, unlike `CreateProjectRequest`: this is `patch`, not `put` (see the operation
# below), so a field present is set and a field absent is left as it is — the same partial-update
# meaning `board.ck`'s `PATCH /api/cards/{id}` comment gives `EditCardRequest`. There is deliberately
# no `name` here — `wilson.projects.name` is the same value the `project` column carries in every
# other `runner` table, nothing in the schema has a foreign key to it, and a rename would silently
# orphan every card, event, version and setting rather than failing. The name lives in the path
# (`/api/projects/{name}`) and nowhere in any request body on this contract.
contract UpdateProjectRequest: {
    codeRoot?: string
    worktreeRoot?: string
    runRoot?: string
    repository?: string
}

# The query for `GET /api/projects/directories`. A named contract rather than an inline `query:` so
# the generator honours `?` (see `ListQuery` in board.ck). No `path` means the browse root
# (`PROJECT_BROWSE_ROOT`, or the daemon user's home folder), which is also the furthest up the
# listing will go.
contract DirectoryQuery: {
    path?: string
}

# One folder on the daemon's machine and the folders directly inside it, for the web app's folder
# picker when registering a project. A browser cannot supply an absolute path from its own picker,
# and the paths `CreateProjectRequest` takes are the daemon's, not the browser's, so the daemon is
# the only thing that can answer "what is in this folder".
#
# Names only, and folders only: no files, sizes or permissions. `parent` is absent at the browse
# root, where browsing stops. Hidden folders are included; hiding them is the picker's choice.
contract DirectoryListing: {
    path: string
    parent?: string
    directories: array(string)
}

# No project header or `?project=` is required, and none is refused: `ProjectContextRouter`
# (routes.setup.ts) only refuses a project that is *named and unregistered* — with neither set, it
# falls back to the daemon's own configured project and calls `next`, the same as every other route
# on this surface. That catch-all is already correct for a route that lists every project, so no
# exemption was added for it.
operation /api/projects: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List projects
        service: ProjectsService.list
        response: {
            200: {
                application/json: array(Project)
            }
        }
    }
    # Card 0168. Returns `Project` — the name alone, not the four paths just sent — the same
    # response shape `get` above answers with. Card 0162 withheld those four paths from an
    # unauthenticated read surface on purpose; echoing them back from a write would reverse that
    # quietly, for a caller that already has them. `ProjectsService.create` is where the path
    # validation and the duplicate-name refusal live.
    post: {
        name: Register project
        service: ProjectsService.create
        request: {
            application/json: CreateProjectRequest
        }
        response: {
            201: {
                application/json: Project
            }
            # A path missing, empty, or not absolute. `init`'s precedent for a malformed request,
            # carried via `details` as every other refusal on this surface is.
            400:
            # The name is already registered, or `codeRoot` holds something other than `repository`.
            # `init`'s own precedent for "this already exists", not a primary-key error reaching
            # the client.
            409:
            # GitHub or git failed while cloning `repository`.
            502:
        }
    }
}

# Card 0168. `name` is not a field of `UpdateProjectRequest` above — it lives here, in the path,
# because it is the one thing this operation must never change. `POST /api/projects` is the only
# creator of a `wilson.projects` row; this corrects one already registered.
operation /api/projects/{name}: {
    params: {
        name: string
    }
    # Not `put`. Fields present in the body are set; fields absent are left as they are — see
    # `UpdateProjectRequest`'s own comment, and `board.ck`'s `PATCH /api/cards/{id}` for the same
    # reasoning stated once and not repeated differently here.
    patch: {
        name: Update project paths
        service: ProjectsService.update
        request: {
            application/json: UpdateProjectRequest
        }
        response: {
            200: {
                application/json: Project
            }
            # A path present in the body but empty or not absolute.
            400:
            # No project registered under this name.
            404:
        }
    }
}

# Lists folders on the daemon's machine, confined to `PROJECT_BROWSE_ROOT`, or the daemon user's
# home folder without one: a path outside it (after resolving symlinks) is refused rather than listed. A disclosure weighed the way
# `CreateProjectRequest`'s comment weighs accepting paths: only an authenticated caller reaches it,
# and the operator can already read the disk as this user.
# That confinement is what keeps the listing to the part of the disk a project lives in.
# Path segment, not a project: `/api/projects/{name}` has no `get`, so there is no clash.
operation /api/projects/directories: {
    get: {
        security: {
            policy: wilson.view
        }
        name: List directories
        service: ProjectDirectoriesService.list
        query: DirectoryQuery
        response: {
            200: {
                application/json: DirectoryListing
            }
            # `path` is not absolute, or names something that is not a folder.
            400:
            # `path` is outside the browse root, or the daemon cannot read it.
            403:
            # Nothing exists at `path`.
            404:
        }
    }
}
