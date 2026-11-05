---
name: serverkit
description: Build or change server-side code in Wilson's API on ServerKit (the `@maroonedsoftware/*` packages over InjectKit): modules and DI registration, services and Kysely repositories, config, errors, policies, pg-boss jobs, SSE feeds and the server lifecycle. Use when adding a service, store, repository, job, module or config key under `apps/api/src`, when a container can't resolve something, when wiring start-up or shutdown work, or when unsure which `@maroonedsoftware` package or idiom to use. For the HTTP surface itself, use the `contractkit` skill.
---

# ServerKit in Wilson

`apps/api` is one process: the HTTP API and the job runner that drives the board. It is built from ServerKit's packages on InjectKit DI. Routes are generated from contracts (`contractkit` skill); everything behind them is hand-written in `src/modules/<area>/`.

## Reference

Each package ships an `AGENTS.md` written for this purpose. Read the one you need before using a package you haven't used in this session:

```
apps/api/node_modules/@maroonedsoftware/<package>/AGENTS.md
```

| Package | For |
| --- | --- |
| `koa` | `ServerKitModule`, `ServerKitServerBuilder`, `ServerKitRouter`, `requirePolicy`, middleware, SSE (`openSseStream`) |
| `appconfig` | Config sources and `${...}` resolvers |
| `kysely` | `KyselyPool` and Postgres helpers |
| `errors` | `httpError(status).withDetails(...)` |
| `policies`, `authentication` | Policy evaluation, sessions, API keys, factors |
| `jobbroker` | `Job`, `JobBroker`, `JobRunner` over pg-boss |
| `serverfeed` | In-process event feeds behind SSE |
| `logger`, `cache`, `encryption`, `zod`, `utilities`, `mcp`, `multipart` | As named |

`PROJECT.md` (Architecture, Authentication, Plugins) explains why Wilson uses them the way it does.

## Layout of an area

`src/modules/learnings/` is the small, complete example:

- `learnings.module.ts`: the `ServerKitModule` that registers everything in the area.
- `learnings.service.ts`: the service the contract binds to. Takes and returns the generated types from `#src/generated/<contract>.js`, maps stored rows to them, holds the rules.
- `learnings.store.ts`: an abstract `LearningsStore` token plus `PostgresLearningsStore`. Registering through the abstract class lets a test swap in a fake without touching the module.

Files use dot names (`rule.proposal.service.ts`), imports use `#modules/...`, `#shared/...`, `#src/...` aliases with `.js` extensions, and tests live in `apps/api/tests/` mirroring `src/`.

## Modules and DI

```typescript
export const LearningsModule: ServerKitModule = {
    name: 'Learnings',
    setup: async (registry: Registry, config: AppConfig) => {
        registry.register(LearningsStore).useClass(PostgresLearningsStore).asTransient();
        registry.register(LearningsService).useClass(LearningsService).asTransient();
    },
    start: async (container: Container) => { /* after every setup; resolve and start things */ },
    shutdown: async (container: Container) => { /* reverse order */ },
};
```

- Every injectable class carries `@Injectable()` from `injectkit` and takes its dependencies through the constructor. Abstract tokens are `@Injectable()` abstract classes.
- `.asTransient()` for services and repositories; `.asSingleton()` only for things holding real state (pools, runners, connection maps, caches). Other forms in use: `.useInstance(value)` and `.useFactory(container => ...)`.
- `setup` registers, `start` resolves and starts, `ready` runs once the server listens, `shutdown` tears down. Never resolve from the container inside `setup`.
- Add a new module to `src/modules/modules.ts`. **The order matters**: `setup`/`start`/`ready` walk it forwards and `shutdown` backwards. Data is first, Jobs is last. Read that file's comment before placing a module.
- `tests/server/container.setup.test.ts` resolves every registration. A class that takes `ServerKitContext` or `JobContext` (request- or job-scoped) cannot resolve at boot; add it to `NOT_RESOLVABLE_AT_BOOT` there.
- A route handler resolves its service from `ctx.container`, the request scope, so a request-scoped service sees the caller's session.

## Data

- Inject `Kysely<DB>` (`#modules/data/db.js`) into a repository or store. Keep SQL out of services.
- Tables live in the `wilson` schema; column names are camelCase in TypeScript.
- Migrations are dbmate files in `apps/api/data/migrations/` (`pnpm --filter @wilson/api migrate:create <name>`). After adding a table, update `src/modules/data/db.ts` by hand, or follow the memory note on regenerating db types: `build:datatypes` strips the hand-kept overrides.
- Most data is per project. Read the current project from `BoardConfig.project` on every call rather than caching it; `runAsProject(name, fn)` (`#modules/board/project.context.js`) sets it for background work.
- Dates are Luxon `DateTime` in UTC.

## Config

`buildConfig()` in `src/cli-bootstrap.ts` layers the environment and `apps/api/.env`, with `__` as the group separator. Read keys through `#shared/require.config.js` (`requireConfigString`, `optionalConfigString`, `configNumber`) so a missing value fails loudly at boot. Runtime settings an operator changes belong in the settings store (`src/modules/settings`), not config.

## Errors and policy

- Throw `httpError(status).withDetails({ reason: '...' })` from `@maroonedsoftware/errors` for anything the caller should see; the CLI prints `reason`. Use `.withInternalDetails(...)` for 500s whose detail must not reach the client. A status thrown from a service should be listed in the contract.
- Plain `Error` becomes a 500 with no detail. That is the data-exposure boundary: never put secrets in `details`.
- Policies are `wilson.view`, `wilson.manage` and `wilson.step.up`, defined in `src/modules/policy/access.policies.ts`. Generated routes apply them from the contract; a hand-written route uses `requirePolicy({ policy: VIEW_POLICY })`.

## Jobs

Background work goes through pg-boss via `@maroonedsoftware/jobbroker`, owned by `src/modules/jobs/jobs.module.ts`:

1. A class extending `Job<Payload>` with `@Injectable()` and `async run(payload)`. Payloads are JSON, so carry `project` and call `runAsProject` inside `run`.
2. Export a `JobQueuePolicy` (`retryLimit`, `expiresIn`) and a `JobWorkerPolicy` (`concurrency`).
3. In `JobsModule.setup`: `registry.register(MyJob).useClass(MyJob).asTransient()` and `jobRegistry.set('card.my-thing', { job: MyJob, policy, worker })`.
4. Enqueue with an injected `JobBroker`: `await broker.send('card.my-thing', payload)`.

A job that spends model calls must check the project's output ceiling first, as `RuleProposalJob` does. A long-running job must survive the API restarting; see `card.jobs.ts`.

## Live updates

Clients learn of changes over SSE, not polling. `EventLog.append` writes an event and issues Postgres `NOTIFY`; `startCardFeedListener` bridges it onto the in-process feed that `/api/feed` streams. The other streams (`PlanStreamRouter`, `ChatStreamRouter`, `ReviewStreamRouter`) are hand-written in `src/routes/routes.setup.ts` around `openSseStream`; follow them, and take the server's `lifecycleSignal` so shutdown closes the stream.

## Running and testing

- Start the API with `pnpm --filter @wilson/api start`, not `dev`: `--watch` restarts it on every merge and abandons a running stage.
- Tests: `pnpm --filter @wilson/api test`. Route tests boot a real server with `startTestServer` from `#tests/support/test.server.js` against the shared test database on `localhost:15533`. Suites in other worktrees share it, so a failure can be another run's; re-run alone before believing it.
- Before a PR, also run `typecheck` and `prettier --check`; CI runs both.
