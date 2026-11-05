---
name: contractkit
description: Add or change a Wilson API endpoint through its ContractKit `.ck` contract and regenerate the router, Zod types, TypeScript/Kotlin/C# SDKs and MCP tools. Use whenever a task touches `apps/api/data/contracts/*.ck`, adds, renames or removes an API route, request or response field, changes an endpoint's policy or MCP exposure, or edits anything under `src/routes/*.router.ts`, `src/generated/`, `packages/sdk*/` or `src/modules/mcp/generated/` (all generated, never hand-edited).
---

# ContractKit in Wilson

Every HTTP route in `apps/api` (except the five hand-written routers in `src/routes/routes.setup.ts`) comes from a `.ck` file in `apps/api/data/contracts/`. One contract generates, per `apps/api/contractkit.config.json`:

| Output | Path |
| --- | --- |
| Koa router | `apps/api/src/routes/{file}.router.ts` |
| Zod schemas and types | `apps/api/src/generated/{file}.ts` |
| MCP tools and catalog | `apps/api/src/modules/mcp/generated/` |
| TypeScript SDK (CLI, web) | `packages/sdk/src/` |
| Kotlin SDK (Android) | `packages/sdk-kotlin/` |
| C# SDK (desktop) | `packages/sdk-csharp/` |

All of these are generated and committed. Never edit them by hand: change the contract and regenerate. The service a route calls is the hand-written part.

## Reference

The packages ship their own docs. Read them rather than guessing syntax:

- Language: `node_modules/.pnpm/@contractkit+core@*/node_modules/@contractkit/core/dist/language.md`. The grammar `dist/contractkit.ohm` beside it wins when the prose disagrees.
- Generator options: `apps/api/node_modules/@contractkit/plugin-typescript/llms.txt`
- CLI and config: `apps/api/node_modules/@contractkit/cli/llms.txt`

The existing contracts are the best style guide. `learnings.ck` is small and complete; `rules.ck` shows params, step-up writes and documented error statuses.

## Shape of a contract

```
options {
    services: {
        LearningsService: "#modules/learnings/learnings.service.js"
    }
    security: {
        policy: wilson.manage        # the file's floor
    }
}

# Comments above a contract or operation become doc comments in every output.
contract SetLearningsRequest: {
    markdown: string(min=1, max=100000)
    message?: string
    severity?: enum(blocker, concern)
    tags: array(string)
    cardTitle: string | null
}

operation /api/rules/{id}: {
    params: {
        id: string
    }
    patch: {
        name: Update rule
        sdk: updateRule              # optional SDK method name
        mcp: exclude # say why: human-only, spends money, etc.
        service: RulesService.update
        security: {
            policy: wilson.step.up
        }
        query: SomeQuery             # GET filters
        request: {
            application/json: PatchRuleRequest
        }
        response: {
            200: {
                application/json: Rule
            }
            # What the service throws for this status, and when.
            409:
        }
    }
}
```

Types in use here: `string`, `int`, `number`, `boolean`, `datetime`, `json`, `binary`, `array(T)`, `record(K, V)`, `enum(a, b)`, `T | null`, `string(min=, max=)`, `number(min=, max=)`. A `?` field is optional (`undefined` in TypeScript).

## Wilson conventions

- **Policy.** Set a floor in `options.security` and lower it per operation. `wilson.view` for reads, `wilson.manage` for ordinary writes, `wilson.step.up` for writes PROJECT.md decision 8 keeps human-only (no API key ever satisfies it). `security: none` only for sign-in itself (`auth.ck`). The names live in `src/modules/policy/access.policies.ts`.
- **MCP.** Every operation lands in the chat's MCP catalog unless it says `mcp: exclude`, with a trailing comment giving the reason. Exclude anything human-write-only, anything that spends model calls, and anything the chat must not reach.
- **Errors.** List each status the service can throw (`400:`, `404:`, `409:`) with a comment saying when. The service throws `httpError(409).withDetails({ reason: '...' })` from `@maroonedsoftware/errors`; `details.reason` is what the CLI prints.
- **Params.** A `params` block is keyed by name, so two `{id}` segments in one path cannot be expressed. Name the second one (`{questionId}`, `{contextId}`).
- **Comments.** Explain why an endpoint exists and why it is gated the way it is, as the existing files do. They are copied into the generated code and SDKs.
- **Versioned app API.** `app.api.ck` is the stable surface operator apps call. Add to it with a new `...V1`/`V2` SDK name rather than changing an existing operation's shape.

## Regenerate

From `apps/api`:

```bash
./node_modules/.bin/contractkit
```

It prints `Compiled N file(s) (X written, Y unchanged)`. Add `--force` to skip the incremental cache. `pnpm --filter @wilson/api codegen` does the same but fails inside the Bash sandbox (pnpm's dependency check), so call the binary directly. A parse or reference error names the file and line; nothing is written until it passes.

Then check `git status`: a contract change should touch the router, `src/generated/`, the MCP generated files and all three SDKs. If one SDK did not change, the plugin for it did not run.

## New contract file checklist

A new `.ck` file needs hand wiring beyond codegen (see commit `65f1787e`, which added `devices.ck`):

1. The service under `src/modules/<area>/`, `@Injectable()`, taking and returning the generated types from `#src/generated/<file>.js`. Register it in that area's `ServerKitModule` (see the `serverkit` skill).
2. Mount the new router in `routers()` in `src/routes/routes.setup.ts`, before the hand-written SSE routers.
3. Update the tests that pin the router list: `tests/routes/routes.setup.test.ts` (positions and length) and `ROUTERS` in `tests/modules/mcp/mcp.catalog.test.ts`.
4. If the service takes `ServerKitContext` (anything request-scoped, like the session), add it to `NOT_RESOLVABLE_AT_BOOT` in `tests/server/container.setup.test.ts`.
5. Route tests in `tests/routes/<file>.routes.test.ts` over real HTTP with `startTestServer`, `onboardAndSignIn` and `request` from `#tests/support/test.server.js`. Cover the 401 without a session, the happy path, and each documented error status.
6. Anything a CLI command or the web app calls goes through the generated `packages/sdk` client, never a hand-built `fetch`.

Changing an existing contract usually needs only step 5 plus the service.

## Before a PR

Run `typecheck` and `prettier --check` as well as `test` and `lint`: CI's build job runs both and the others do not catch them. Deploy the API before shipping a desktop or Android release that calls a new endpoint.
