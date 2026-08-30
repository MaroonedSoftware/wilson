options {
    services: {
        ProjectsService: "#modules/board/projects.service.js"
    }
    security: none
}

# Card 0162. The deployment's project registry (card 0148's `runner.projects`), not any one
# project's board — the same distinction card 0152 drew between project and deployment settings.
# Every operation in `board.ck` describes work *within* one project; this one describes the
# deployment itself, which is why it lives in its own file beside `board.ck` rather than inside it.
# `contractkit.config.json` discovers contracts by glob (`apps/api/data/contracts/**/*.ck`), so
# adding this file needed no configuration change.
#
# `security: none`, for the reason board.ck, health.ck and settings.ck already state: the API binds
# to 127.0.0.1 (BoardConfig/server startup) and has no auth boundary yet (card 0019) — anything that
# can reach this port could already read `runner.projects` directly.
#
# Card 0154 hit this directly: it needed a project switcher, and had no endpoint to ask what
# projects exist. Its own Files in scope (`apps/web/src/**`) put this endpoint out of reach, so it
# lands here instead, as its own in-scope work, for 0154 to consume.

# One registered project's identity, as far as an HTTP caller needs to know it. `ProjectRow`
# (project.repository.ts) also carries `boardRoot`, `codeRoot`, `worktreeRoot` and `runRoot` —
# filesystem layout of the machine the daemon runs on — which are withheld here: a switcher needs
# names, and an unauthenticated surface (see `security: none` above) is a reason to return the
# minimum that serves the consumer, not a licence to expose everything `ProjectRepository.list()`
# already reads.
contract Project: {
    name: string
}

# No project header or `?project=` is required, and none is refused: `ProjectContextRouter`
# (routes.setup.ts) only refuses a project that is *named and unregistered* — with neither set, it
# falls back to the daemon's own configured project and calls `next`, the same as every other route
# on this surface. That catch-all is already correct for a route that lists every project, so no
# exemption was added for it.
operation /api/projects: {
    get: {
        name: List projects
        service: ProjectsService.list
        response: {
            200: {
                application/json: array(Project)
            }
        }
    }
}
