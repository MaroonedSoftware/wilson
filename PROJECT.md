# PROJECT.md

Kickoff brief for a stage-based agent runner over a task board, with an HTTP API,
a web board, and interactive planning.
Read this before planning. Ask about anything left open here before writing code.

## What we are building

A daemon that tracks task boards for several project repos, picks up
cards that are ready for their next stage, runs a headless coding agent against
that card in an isolated git worktree, verifies the result against a
machine-checkable exit condition, and advances or kicks back the card accordingly.

A web app sits on top: a Kanban board per project, live stage progress, and an
interactive planning surface where the human converses with the planning agent,
highlights passages of the draft plan to comment on them, and approves the result.

The human writes plans conversationally, approves them, and reviews diffs.
Everything between those two points runs unattended.

## Decisions already made

These are settled. Challenge them only if you find a concrete blocker.

1. **Postgres is the system of record for the board; git is the system of record
   for code.** Cards, card versions, transitions, events, planning sessions, comment
   anchors, budget accounting and the stage config itself are rows. The code repo holds code and nothing else.
   Durability is the database's problem — backups and point-in-time recovery — not a
   property the architecture provides by keeping a second copy in another store.
   Previously the board was markdown in a sibling git repo, which made every
   transition a two-phase write: commit the card file, then append the event, with no
   way to reconcile a partial failure. A transition and its event now share a
   transaction.
2. **We own the board schema.** Backlog.md was evaluated for the CLI, MCP server,
   and web Kanban it provides; we are building our own API and UI, which was most
   of its value, and its schema could not be assumed to carry the plan contract. Its
   markdown substrate is the other reason: a board with more than one writer wants
   transactions, and a directory of files cannot provide them.
3. **Board mutations go through the API.** There is no second path — no file to
   hand-edit, no parser to break, no out-of-band writer to reconcile. Agents, the CLI
   and the web app all call the same typed layer. The operator's escape hatch is
   `wilson card edit`, which opens `$EDITOR` and submits the result.
4. **The plan file is the contract.** Downstream stages read the plan and the repo.
   They never inherit the planning conversation. Comments and chat are planning-time
   scaffolding; only text that lands in the plan file binds anything.
5. **Agents do not move their own cards.** They produce artifacts and exit. The
   runner verifies the exit condition and writes the transition. Sole writer.
6. **The board is not in the code repo. Code lands on branches.** One worktree and
   one branch per card. Board state is unreachable from a worktree by construction
   rather than by a deny rule, so the corollary holds absolutely: the board is not
   readable state for an agent, and the plan is its only input. The write tool's deny
   list still covers `.runner/` for decision 8.
7. **Stages are config, not code.** Re-routing models, changing a provider or tuning a
   budget is a data edit, not a release. A project's lanes are rows in `wilson.lanes`, read
   through `StageConfigStore` and edited with `wilson stages set`, `instructions` and `route`;
   every change is a revision in `wilson.lane_revisions`, and the next dispatch reads it, no
   restart involved. Lanes rarely change shape, so adding or removing one takes a migration.
8. **Agents cannot modify the machinery.** Stage config, stage prompts, checked rules and
   everything under `.runner/` are human-write-only. What actually enforces that differs by
   path. The board is unreachable from a worktree by construction (decision 6) — there is no
   file there for any tool or command to reach, since board state is rows in Postgres, not
   files on the mounted disk. `.runner/**` and `**/stages.yaml` are enforced by `ScopeGuard`'s
   `ALWAYS_DENIED` list, which `request_scope` cannot widen (`scope.guard.ts`) — but only
   against the write tools; see the guardrail-vs-boundary note atop `command.allowlist.ts` for
   why that stops the write tool and not a command that runs project code. The plan is
   materialized outside the worktree at dispatch precisely so it cannot land on the card's
   branch, but that only discourages tampering with it: the write tool refuses it because the
   path resolves outside the worktree root, not because anything names and denies that specific
   path, and a command running project code is bounded by neither check. This system is meant
   to build itself under review; an agent that can rewrite its own exit condition passes every
   time.
9. **One project is one board.** Everything below is per project: board rows, stage
   config, worktree root, port range, git credentials. A project is a row, not a
   directory — which is what makes twenty projects twenty rows rather than twenty git
   clones the daemon must hold open and keep current.
10. **Every API request is authenticated; reaching the port is not authority.** One operator
    account plus scoped API keys, with no localhost bypass. Decisions 5 and 8 assumed the only
    thing that could call the API was the operator. That was never enforced: a command a stage
    is allowed to run executes project code, project code can open a socket, and the API used
    to trust whatever reached `localhost:13100`. A test file on a card's branch could transition
    its own card. Single operator still holds (see Non-goals). What changes is that the operator
    is a principal the API checks, not an assumption about who is on the network. See
    Authentication.

A retired decision, recorded because its absence is load-bearing: _"state is per-card
and append-only; no shared index file that every agent touches, so parallel commits
merge clean."_ That was a constraint imposed by git's merge semantics. Rows do not
merge, and nothing downstream depended on it except the board format.

## Architecture

| Piece                  | Built with                                                                     |
| ---------------------- | ------------------------------------------------------------------------------ |
| API + daemon           | ServerKit (`koa`, `appconfig`, `kysely`, `logger`, `permissions`) on InjectKit |
| API surface            | ContractKit `.ck` contracts → Koa router + Zod + typed SDK                     |
| Queue, leases, retries | `@maroonedsoftware/jobbroker` (pg-boss)                                        |
| Live updates           | `@maroonedsoftware/serverfeed` → SSE via `@maroonedsoftware/koa/serverfeed`    |
| Agent invocation       | AI SDK `ToolLoopAgent` with our own worktree-scoped tools                      |
| Operator CLI           | `@maroonedsoftware/johnny5` (commands + `doctor`)                              |
| Typed agent access     | `@maroonedsoftware/mcp`, exposing the same board operations                    |
| Web app                | React + Mantine + TanStack Query over the generated ContractKit SDK            |
| Plugins                | `ServerKitModule` registrations; `cache` `IdempotencyStore` for webhook dedupe |

One ContractKit contract generates the Koa router, the Zod validators, and the SDK
the web app's query hooks wrap, so the API cannot drift from its client.

The web app does not do optimistic transitions. Moving a card in the UI is a
_request_; the runner is sole writer (decision 5) and may reject it for a dependency
block or an in-flight job, so rendering the new column before it is real renders a
lie. Transitions arrive over SSE and invalidate the relevant TanStack query. The
UI-initiated transitions are human-gate approvals, which are rare enough that a round
trip is imperceptible. Drag feedback is animation, not state — optimistic _ordering_
within the parking lot is fine, because ordering is not runner state.

### The API is the daemon

There is one process that drains the queue, and it is `apps/api`. Starting the server
(`pnpm --filter @wilson/api start`, or the compose stack in Deployment) runs ServerKit's full
`setup -> start -> ready -> shutdown` lifecycle, and `JobsModule.start` is what starts the
`JobRunner` — draining whatever is already queued, and enqueueing more itself when
`POLLER_ENABLED` is set (see below). There is no second way to do this: card 0079 retired `wilson
run`, the CLI command that used to start a `JobRunner` by hand in-process, once it became possible
for the API server and that command to both be running against the same queue at once — pg-boss
does not know they are the same logical daemon, so two processes meant two workers and, after card
0049 added the poller, two pollers each enqueueing a card per tick. `wilson doctor`'s "daemon not
stale" check asks the running API's `/api/health` for its start time rather than grepping a
process table, for the same reason: a process table has no way to tell you the API itself is the
thing draining the queue.

**In development, `pnpm dev` (`apps/api`) is `node --watch`**, and this project self-hosts: a
source change under `apps/api/src` restarts the process mid-stage, abandoning whatever job it was
running (observed 2026-08-25 — merging one card restarted the server and killed another card's
testing stage, which then looked like a wall-clock timer failing when the process holding the
timer was simply gone). `wilson run` used to be the workaround, run in a second terminal, stable
by construction because it was never the thing `--watch` restarted. With `wilson run` retired,
the stable equivalent already exists and needs no new script: `pnpm --filter @wilson/api start`
runs the same entrypoint without `--watch`. Use `pnpm dev` to iterate on code with nothing
in flight; use `start` — or the compose stack — whenever a card must be allowed to run to
completion. A `--watch` that special-cased an in-flight job, or a poller that refused to start under a
watcher, were both considered and rejected: either adds runtime logic whose only job is to guess
whether it is safe to restart, when the operator already knows and `start` already exists as the
answer. "Don't run `--watch` while a card is mid-flight" is one sentence, not a special case.

### The daemon is not a poller

`jobbroker` replaces the hand-rolled lease loop. pg-boss already provides
visibility timeouts, retry limits with backoff, cancellation of queued _and
running_ jobs, and dead-letter capture. The mapping:

- claim with lease → job fetch with visibility timeout
- expired lease requeue → pg-boss redelivery
- `poisoned` terminal state → dead-letter queue, inspectable and redrivable
- max kickbacks → per-queue retry policy

What remains ours: verifying exit conditions, writing transitions, and reclaiming
the worktree and port when a job dies. On redelivery the runner discards any
artifacts from the interrupted attempt and re-dispatches from a clean worktree;
partial output is never verified.

**Throughput is bounded, and the bound is a measured choice rather than an inherited default.**
`CARD_STAGE_CONCURRENCY` names how many `card.stage` jobs run at once on a daemon process: three.
It is declared, not inherited. jobbroker 1.12.0's `JobWorkerPolicy` is what `JobsModule`
(`apps/api/src/modules/jobs/jobs.module.ts`) sets on the `card.stage` registration as
`CARD_STAGE_WORKER`, so this is the number the queue actually runs on. Card 0115 then made it a
`card-stage-concurrency` row bounded to 1..8, leaving the constant in
`apps/api/src/modules/jobs/job.runner.config.ts` as the coded default at the bottom of
`SettingsStore`'s resolution order.

It matters because each concurrent stage is a git worktree, a `pnpm install`, and an agent, so the
number trades the host's disk and memory for throughput. Three was reached by measuring this
workstation at two: load average 5.07 across 18 CPUs, 5.7GB free plus 12.7GB reclaimable, the runner
barely registering because agents spend most of their time waiting on the model API and card 0081's
lock already serialises installs. The machine is not what binds. Scope collisions, the merge gate,
and the testing stage's CPU cost all bind first, so raise this on evidence one of those has moved
rather than on spare CPU.

pg-boss fixes a queue's concurrency at `pgboss.work()` time, so a row written while the daemon is
running cannot reach the live worker the way a poller-interval write reaches the next tick.
`BoundedCardStageJobRunner` (`jobs.module.ts`) waits until the board is genuinely idle and swaps
it then.

### Two adapters, chosen per stage

A stage names its engine in config: `adapter: api | cli`.

**`api`** drives the AI SDK's `ToolLoopAgent` against a provider key. One interface
across Anthropic, OpenAI and xAI, so per-column model routing is a config value.
We own the tool set — read, write, edit, glob, grep, bash — scoped to the card's
worktree, and that is where decisions 6 and 8 are enforced: a write outside the
plan's files in scope, or into board paths or `.runner/`, fails at the tool rather
than in a post-hoc diff check. The result comes back through a `report_result`
tool, and `stopWhen` ends the loop when the agent calls it.

**`cli`** drives the Claude Code engine through `@anthropic-ai/claude-agent-sdk`,
authenticating from the operator's own credentials — no API key and no per-token
billing. AI SDK's `HarnessAgent` was the obvious route and is not usable here: its
Claude Code and Codex adapters are bridge-backed and require a network sandbox with
an exposed port, which is the opposite of a self-hosted deploy against mounted
repos.

The two fail independently, and that is the point rather than a side effect. An
exhausted API balance stops every `api` stage and leaves `cli` untouched; a
logged-out workstation does the reverse. This was not foresight — the `cli` adapter
was built the day the API credits ran out mid-card.

#### What the cli adapter costs

The engine brings its own loop and its own tools, so `ScopeGuard` and
`CommandAllowlist` are not the tools themselves. They are put back through one guard
(`createToolGuard`), reached two ways: a `PreToolUse` hook first, and `canUseTool` as
a backstop for any call that still reaches it.

The hook exists because `canUseTool` alone was found not to be enough. On host engine
2.1.266, a diagnostic run on 2026-09-19 made one Bash call (`true`) with a `canUseTool`
that refused everything; the command ran anyway, and `canUseTool` was called zero
times. The same call against a `PreToolUse` hook, run the same day, was consulted
once, and a `deny` from the hook did stop it — the engine got "refused by PreToolUse
hook" back and nothing ran. So permission now comes from the hook first, with
`canUseTool` left wired to the identical guard rather than removed, since a call the
hook does not catch for whatever reason must still have somewhere to be checked. The
guard's own decision logic is unchanged by any of this; a call seen through both doors
records its deny credit, `tool.denied`/`tool.executed` events, and the repeat-refusal
counter once, keyed by the engine's own `tool_use` id, not twice.

**`allowedTools` must not be set.** Listing a tool there marks it _pre-approved_ and
the engine never consults `canUseTool` for it — so naming Write and Bash as allowed,
which reads like granting exactly the intended permissions, silently disables every
check meant to constrain them. Measured, not reasoned about: with Write allowed, a
probe wrote a file outside the declared scope and the guard was never called once.
Permission comes solely from the callback, whose final branch denies any tool it does
not recognise.

**`tools` names the built-ins a stage can use: Read, Glob, Grep, Write, Edit and Bash.** A
native engine build leaves Glob and Grep out of its default set, in favour of `find` and
`grep` through Bash, which the command allowlist refuses by pointing at those same tools.
Unlike `allowedTools`, `tools` only makes a tool exist, and the guard still decides each call.

The `report_result` tool is supplied to this adapter as an in-process MCP server
carrying the stage's own result schema. Without it a stage can only return prose,
which the review verifier rightly refuses, and the runner cannot tell an adapter
defect from bad work — it kicks the card back to implementing for something no amount
of re-implementing can fix.

#### Proving it against a live engine

What this adapter assumes about the engine (the guard is consulted, a denied command costs no step,
`report_result` reaches its MCP handler) is asserted by probes that drive a real engine:
`apps/api/tests/modules/agent/cli.engine.contract.probe.ts` (card 0231). The default test run never
collects them, so no stage runs them. An operator runs them by hand, and they spend real turns on
the operator's subscription:

```bash
WILSON_RUN_ENGINE_PROBES=1 pnpm --filter @wilson/api test:engine
```

That tests the `claude` on `PATH`, the binary a stage on a remote host starts, and refuses to start
unless it is `CLAUDE_BINARY_VERSION`. A stage on this machine starts the engine bundled with the SDK
instead, so add `WILSON_PROBE_ENGINE=bundled` to test that one. They can differ, and a model can
require a newer engine than either: the API then answers with a 400, which the engine reports as a
successful turn with no tool calls (`turn.empty`). The message is in `stage.failed`'s
`trace.finalMessage`.

Starting an engine from inside another engine works. Card 0233 suspected otherwise: on 2026-09-04
all six probes failed inside a `testing` stage in about 500ms each, and it blamed the host session's
`ANTHROPIC_BASE_URL` and `CLAUDE_CODE_*` variables leaking into the nested engine. On 2026-09-19 a
probe run from inside a Claude Code session passed both with those variables present and with all
27 of them removed. The 09-04 failure was most likely the credential itself: the same note records
that the CLI, run by hand in that environment, failed with "OAuth session expired and could not be
refreshed". So `subscriptionEnv` still removes only the two provider keys. Whether a probe passes
when run from inside a real stage, under the stage's own config directory, is still unmeasured.

Those probes need a subscription, so nothing runs them on a schedule. `engine-compat.yml` asks a
narrower question nightly, of the pinned engines and the newest ones, with no account and no model
call: does the Claude handshake still complete with the pinned SDK, and has the protocol Codex
declares drifted from `apps/api/tests/support/codex.protocol.kinds.json`? A new Codex item type fails
it, because `itemStarted` lets through anything outside `TOOL_ITEMS` unguarded. So does a new server
request, or the loss of a kind the adapter reads. A new notification is only noted. A binary that is
missing or will not run fails too, since a check that could not run is not a pass. It cannot see what
an engine does during a turn, so a skipped guard still takes the live probes to find.

To run it by hand, or rewrite the baseline for a version bump and read the diff:

```bash
WILSON_ENGINE_COMPAT=1 CLAUDE_PROBE_BIN=$(which claude) CODEX_PROBE_BIN=$(which codex) pnpm --filter @wilson/api test:engine:compat
CODEX_KINDS_UPDATE=1 WILSON_ENGINE_COMPAT=1 CLAUDE_PROBE_BIN=$(which claude) CODEX_PROBE_BIN=$(which codex) pnpm --filter @wilson/api test:engine:compat
```

### Where a stage runs: here, an SSH host, or a worker

A stage that cuts a worktree runs where its `placement` says: `local` (the default) on the daemon's
own machine, `remote` on a registered host, or `any` on a host whenever one can run it, waiting for
a slot when they are only busy, and here when none can. Planning sessions and stages with `worktree: none` always run here. A host is a
`wilson.hosts` row (`wilson host add`, the web app's Hosts page) with a number of slots, the projects
it serves and where each one's clone lives on it, and a probe (`wilson host probe`) that has to pass
before placement will choose it. A worker probes itself each time it connects. A host with a
`projectsRoot` also takes on any project with a GitHub repository: the first stage placed there adds
its paths under that folder, and a worker clones it through the GitHub App.

Only the work moves. Everything above the `ExecutionHost` seam (`execution.host.ts`) stays in the
daemon: the Agent SDK's loop, the tool guard and its denials, budgets, verification, the commit,
merges and the board. A host does what the seam asks of it (read and write files in the worktree,
run commands, start the `claude` engine) and the engine's stdio comes back to the daemon, so the
guard sees every tool call wherever the engine runs. Commits move to and from a host's clone through
a `GitTransport` (`git.transport.ts`) on the placement.

There are two kinds of host, fixed when one is registered:

- **`ssh`.** The daemon connects out with `ssh <target>` and runs each primitive as a shell command
  there (`SshHost`); commits move with git's own push and fetch over the same connection. The daemon
  needs a route to the machine and a key for it. An SSH host's engine signs in with
  `REMOTE_CLAUDE_CODE_OAUTH_TOKEN`, sent over stdin.
- **`worker`.** The worker program (`apps/worker`) on the machine connects in instead: a WebSocket to
  `/api/workers/connect`, authenticated with that host's worker token (`wilson host token`), which
  only that endpoint accepts and which names exactly one host. The daemon sends each primitive over
  the connection as a message (`@wilson/worker-protocol`) and the worker answers it with the same
  `node:fs` or `execFile` call `LocalHost` would make (`WorkerExecutor`); commits move as git bundles
  holding only what the other side lacks (`WorkerGitTransport`). The daemon needs no route to the
  machine and no key for it, which is what lets the daemon live in a container on a NAS while the
  stages run on a VM or a laptop. A worker's engine signs in with the token the host is assigned
  (`wilson host engine-token`), sent with each engine start and kept by the worker for no longer than
  that, or else the worker's own `CLAUDE_CODE_OAUTH_TOKEN`. A worker host's `connection` in the API
  is its open connection right now, where `probe` is only what was found the last time one ran.
  `GET /api/hosts/{name}/runs` is what was placed there lately, read from `stage.placed` events.
  Its `connection.metrics` is the machine as the worker last answered (`WorkerStatsSampler`, every
  thirty seconds), held on the connection with no history.

A stage marked `isolated` runs only on a host an operator has vouched for (`wilson host isolated`,
behind step-up), never on this machine, and waits when there is none. It is for an engine that cannot
be relied on to keep a stage inside its worktree. The flag is an operator's word about the machine,
such as a container worker with nothing else inside, since no probe can test it.

The `codex` adapter runs OpenAI's Codex engine through `codex app-server`, and only for a stage marked
`isolated`. `ScopeGuard` and `CommandAllowlist` answer the engine's approval requests, but Codex runs
commands it considers safe without asking, so reads through it are not limited to the worktree. Its
sandbox's network is all or nothing, set by the stage's `networkAccess`, and off by default. The worker
image installs the version the adapter was built against, and a worker passes the engine none of its
Claude credentials. It signs in with a pooled OpenAI API key (`wilson engine-token set <name> --provider
openai --kind api_key --pool`), held in the engine's memory only, or else the sign-in that machine was
set up with. Wilson does not hold ChatGPT session tokens. A `codex login` on a worker does work, but it
leaves `auth.json` where a stage's commands can read it, so a key is the way to run this.

A worker never connects to Postgres, and must not. pg-boss's queue is in the board's database, so a
worker subscribed to it would hold a credential for `wilson.cards` and `wilson.stage_configs` on the
same machine as model-written code, which is the board readable from a worktree: exactly what
decisions 6 and 8 rule out, and what card 0194 removed from the engine's environment. The connection
is the only thing a worker holds, and Wilson drives it; a worker never decides what to run.

A worker confines file primitives to its host's project roots, as the latest `welcome` named them
(the daemon re-sends it whenever it connects to the host for a probe or a placement). That is a
guardrail in the sense the note atop `command.allowlist.ts` uses the word: a command run inside a
root can reach past it. The boundary is the machine, which is why a worker belongs on one kept for it.

A dropped connection fails whatever was waiting on it as a lost host, which the queue retries, and
the worker kills every process the dropped connection started before it reconnects. A daemon restart
still ends the stages running at the time, since the agent loop lives in the daemon. Moving the
loop onto the worker would fix that, at the cost of running the guard beside the code it guards.

**A clean shutdown interrupts a stage rather than failing it.** On shutdown `StageInterrupt` stops
each `cli` engine, the card records `stage.interrupted`, and the handler sends the stage again and
completes, the same way `holdWhileDraining` does, so no retry is spent. This happens before workers
are disconnected and inside pg-boss's stop window. A stage that has already reported is left to
finish. Anything that does not get this far (a crash, a kill, a command stage, an `api` stage) is
left to the boot sweep, which does spend a retry, so a stage that keeps killing the daemon still
dead-letters.

The job sent again names where the tree is, and the next attempt reopens it, uncommitted work included,
rather than cutting a new one: on this machine, or back on the same host if that host can take it.
Elsewhere, or with the tree gone, it cuts one as usual.

In a reopened tree the engine continues its own session, told that it was interrupted and to check its
last step, on what its interrupted runs left of the stage's time, steps and input tokens. If the engine
cannot find the session, a new one starts in the same tree, told what it has inherited. Nothing is
verified until the stage finishes, so a resumed run is held to the same exit condition as any other.

**So a deploy does not have to wait.** A restart costs a running `cli` stage a pause of about a minute
rather than its work: a 2026-11-02 run against a real engine stopped in under a second, resumed the same
session, re-ran the tool the restart killed, and passed with no retry spent. Placed stages have not been
through this against a real worker yet.

**Drain when a restart must not interrupt anything.** That is a deploy that changes what a running stage
depends on (its tools, its result contract, or how a resumed run behaves), one where a command stage,
an `api` stage or a plan draft is running, since those are not resumed, and any restart until placed
stages have been proven. `wilson server drain` lets running stages finish and starts nothing new,
across every project. Auto-mode cannot do this, because a stage that passes enqueues its next stage
directly. The drain is enforced where every stage arrives, as a pre-dispatch check
(`holdWhileDraining`): a job that would have dispatched is sent again for 30 seconds later and hands
its claim to the new job. It spends no retry, and because the job waits in `created` rather than
`active`, the boot sweep leaves it alone through a restart.

A stage already running is waited for, up to its 50-minute cap, rather than suspended. `wilson server
drain --wait` exits once `safeToRestart` is true, which also requires that no plan draft is running,
since a drain does not hold those. Nothing watches for a merge in progress: a merge runs inside a
request, so a deploy still has to avoid one by hand. The drain stays on through the restart so the
new process starts nothing, and `wilson server resume` ends it. `wilson doctor` and a header badge in
the web app both report a drain, because a forgotten one leaves a board that looks healthy and does
nothing.

## Stage model

Each stage declares: input, mode, adapter, provider, model, prompt, allowed tools,
worktree requirement, where its worktree comes from, extra scope, exit condition,
on-pass target, on-fail target, max kickbacks, budget.

`worktree` is one of `none`, `readonly`, or `rw`. Stages that only read a document
and emit a verdict never get a worktree, which keeps worktree churn proportional to
work actually done in a repo.

`worktreeFrom` is `base` or `branch`. `base` cuts fresh from HEAD _when there is
nothing to resume_; a branch already carrying work is always resumed, because only a
passing stage commits, so such a branch is by construction the last state that
satisfied an exit condition. `branch` requires the resume. A card kicked back from
review carries findings citing file:line on its own branch — rebuilding from scratch
would throw away the work those findings are about.

A resumed branch is **rebased onto HEAD before the stage runs**. A card that outlives
a few merges is otherwise implementing against a world that has moved: card 0014 sat
six commits behind while its own plan described an adapter that had landed on main
meanwhile, and the review searched the tree and correctly reported it missing.
Nothing in the pipeline could distinguish "this does not exist" from "this does not
exist _here_", because every exit condition and every reviewer only ever sees the
branch. A conflict aborts cleanly and is treated as permanent — it will not resolve
on a retry.

`extraScope` is globs a stage may write on top of the card's own `Files in scope`. A
card's scope is written for the stage that implements it; the testing stage's whole
job is to add files nobody could have declared in advance.

| parking lot | — | none | never dispatched | promote (human only) |
| planning | manual | none | a person approves, then the `scope-check` step passes | backlog |
| backlog | manual | none | picked up by the poller | implementing |
| implementing | agent | rw | build passes, diff non-empty, diff within scope | testing |
| testing | agent | rw | suite green, test count non-decreasing, no new skips, no weakened tests, new tests fail against the pre-change tree | review |
| review | agent | readonly | findings schema valid, every finding cites a file:line in the card's diff, severity in enum; rule judges' failures are merged in; a `revise` then has to survive the `challenge` step | ready |
| ready | manual | none | human approval | merge, then `done` |
| done | — | — | never dispatched | — |

"No weakened tests" reads the AST of the card's changed TS/JS test files on both sides, and fails on
a net drop in `expect(` and `expect*(` calls across the card, or on a new literal-against-literal
tautology such as `expect(true).toBe(true)`. Moving a test between files nets to nothing. `.toBeTruthy()`
and the like are not flagged. It does not depend on `baselineCheck`, and a lane can turn it off with
`assertionCheck: false`. A card with a good reason declares it as a plan Constraint,
`Expected assertion drop: N (reason)`, whose `N` covers drops and new tautologies together; a stage's
`caveats` do not count. Other languages' test files are not read.

A lane can hold **steps**: runs of their own, with their own prompt, verifier and budgets, on the
lane's provider, model and routes, with the card staying in the lane throughout. `planning` runs
`scope-check` when a plan is approved, and a card waits there under a `planCheck` until it passes,
or until a person reads why it did not. `review` runs `challenge` when it reports `revise`, a fresh
context trying to refute each blocker before anything is kicked back. The card holds nothing of that
`revise` yet, so the step's plan, and only its plan, carries the review's result under `## Review
findings`.

A card in `ready` also reports a `mergeStatus` on every board read: what Merge would do right now,
`clean`, `conflict`, `rereview` (it would go back to review, because the target moved under files the
card changed), `capped` (the same, on a card out of re-reviews, so Merge would flag a human) or
`unknown` (the read failed). It is worked out on read and cached by the two commits,
since an operator fast-forwarding `main` emits no event. A read moves no ref, creates no branch, and
leaves only unreferenced objects behind. It answers against `dry-run-integration` when a dry run would
land there. The status is advice and refreshes when a client next reads the card: Merge still decides
for itself.

A stage that cannot go on without a person's decision can stop and ask one question. It is no verdict
on the work, so no kickback is spent and no `stage.failed` is written: the card is flagged where it
stands with the question as its reason, and `blocked` holds the detail. An answer goes into the plan
under `## Operator answer`, clears the flag and keeps the card's retries, and the stage runs again in
a fresh session, with the stopped run's uncommitted work as its preserved patch. The section is shed
when the stage passes. A stage may ask three times (`retries['<stage>:blocked']`); the next question
is a plain flag, as is any question on a card whose ticket closed during the run. A step cannot ask,
because an answer resumes the lane's own run and the step would be lost.

The table above shows only where a stage goes when it passes; a kickback target — a stage's
`onFail` — is a separate decision and is not automatically the stage before the one that failed. It
is the stage that can fix the failure. `review.onFail: implementing` is correct: a review blocker
is a statement about the code, so the code is what changes. `testing.onFail: testing` is also
correct, and looks wrong at first glance — testing failing is not implementing's problem, and
implementing has nothing left to redo when testing fails its own exit condition (it wrote no tests,
say). Card 0060 hit this the expensive way: `testing.onFail: implementing` sent a passing,
already-committed implementation to a stage with an empty diff to produce; `implementing.onFail:
implementing` then sent that failure back to itself, and the card burned its retries rediscovering
it had already finished — three worktrees and three agent runs to land on `needs-human` with
nothing wrong at any point. A stage whose `onFail` names itself is not a special case: it retries
bounded by its own `maxKickbacks` exactly like a kickback to any other stage, the difference being
that it still has real work left to do.

That "real work left to do" holds when testing wrote no tests or its report is stale, but not when
testing fails because the implementation cannot be tested as written — no seam for an assertion to
attach to, a dependency nothing can fake. A self-loop retrying `testing` cannot fix that either; it
still lands on `needs-human` once `maxKickbacks` is spent, same as any exhausted stage, with a reason
string naming the testing stage and its failure. A human reading that alongside the worktree can tell
the two apart — testing kept trying, or the implementation was the actual blocker — and route the
latter to `implementing` by hand with `wilson card move`. That costs a round of testing attempts
before a human sees it, not a wrong outcome: still strictly better than card 0060's shape, which spent
its retries on an already-correct implementing stage instead.

**The general rule, and where `onFail` still applies.** `onFail`'s target is the stage that can fix
the failure — and when the stage that failed is the one that can fix it, the target is itself. That
is true whenever a stage fails its own exit condition for a reason that says nothing about the
code: a step, wall-clock or token budget cutoff, an engine that stopped responding, a run that never
called the report tool, or a result that never parsed against the stage's schema. None of those is a
verdict on what the stage produced — there was nothing coherent to judge — so routing to whatever
`onFail` names would send a stage that already passed (or one still mid-work) to redo work it did not
fail, exactly the shape card 0060 hit for `testing` and card 0075 hit for `review`: a review that
burned its step budget and never reached a verdict was sent to `implementing`, which had already
passed, at `retries.implementing` 2 of 3 — left alone it would have discarded three stages of correct
work over a slow reviewer, not a code defect. An operator moved it back to `review` by hand.

Card 0062 could not fix this generally: `kickback` (`apps/api/src/modules/stages/kickback.ts`) saw
only which stage failed and how many times, never the run's own outcome, so it had no way to tell
"this stage did not finish" from "this stage judged the work and found it wanting". `StageOutcome`
now carries that distinction (`unjudged`, in `stage.result.ts`), threaded through
`StageDispatcher.writeTransition` into `kickback`: a review with a blocker, or a verifier rejecting an
empty or out-of-scope diff, has judged the code and still routes to `onFail` exactly as before — a
review that exhausted its steps or returned a result that never parsed routes to `review`, whichever
stage failed this way routes to itself, and either way `maxKickbacks` still bounds the retries and
`needs-human` still catches an exhausted one. Card 0060's earlier fix is not what changed: this is the
general form of the same rule, previously encoded only as `testing.onFail: testing`.

`testing.onFail: testing` stays exactly as it is — this card complements it rather than replacing it.
It self-loops on _every_ testing failure, including a well-formed verdict that testing wrote no tests
or its report is stale, which is a judgment about the work `unjudged` deliberately does not cover
(testing has no downstream stage that could act on that judgment differently, which is why card 0062
chose a blanket self-loop for it). `unjudged` only closes the narrower gap card 0062 left open: telling
"testing skipped its own job" apart from "testing failed because the implementation cannot be tested"
would need the same signal — the run's own outcome, not just which stage failed and how many times —
and remains a human call via `wilson card move`, exactly as card 0062 left it.

A run repeating itself is stopped the same way, and sooner than any budget would. Every adapter feeds
its tool calls to a `RepeatedCallWatch` (`apps/api/src/modules/agent/repeated.call.ts`), which counts
identical calls (tool name plus canonical JSON of the input) and sets `AgentRunOutput.loopFailure` at
`REPEATED_CALL_LIMIT`. A successful write clears the count, because the same command against a changed
tree is a new question, so re-running the tests after an edit never trips it; a refused write, or one
identical to the last, clears nothing. `cli` watches the stream rather than the guard, `codex` watches
`item/started` because a read-only command may never ask, and `api` replays its steps in a `stopWhen`.
A write made through a shell command looks like any other command, so it does not clear the count.
The stop is unjudged: it retries in the same stage, in a fresh session, and charges `retries[stage.name]`
so `maxKickbacks` bounds it. It differs from other unjudged failures twice over. The dispatcher skips the
verifier, since the outcome is already decided and testing would run its whole suite to confirm it. And
it writes an attempt bullet, the only unjudged failure that does, so the fresh session knows what the
last one got stuck on. `stage.failed` carries `loopStopped: true`.

Every `stage.failed` also carries `failureClass`, a word for why (`verifier`, `reportRejected`,
`schemaInvalid`, `noReport`, `resultDropped`, `budget`, `engine`, `loop` or `error`), and `reason`, the
failure it leads with. A runner `transition.written` that sent a card back carries the same two, with
`revise` as the class for a review that asked for changes, and one that flagged a card carries the
flag's `reason`. Only `verifier` and `revise` are judgments about the work.

`plan-review` is a separate stage rather than a gate inside planning. It has its own
model, budget, retry policy, and structured output — all stage-level concepts — and
folding it into planning would make planning a stage with two models and two
prompts, which is the special case the first-class-stage rule exists to avoid. It
reads the plan cold with an empty tool set. On fail it returns to planning with
findings attached.

Its verdict schema is deliberately small — big enough to route a kickback, too small
to become a second plan:

```ts
{
  verdict: 'pass' | 'revise',
  findings: Array<{
    severity: 'blocker' | 'concern',
    section: 'goal' | 'constraints' | 'files-in-scope'
           | 'tasks' | 'acceptance-criteria' | 'out-of-scope',
    problem: string,     // what is wrong, one sentence
    suggestion: string   // what would fix it, one sentence
  }>   // capped at 10
}
```

`section` is a closed enum matching the plan's headings. That is the plan-stage
analogue of requiring a code finding to cite a file:line in the diff — it anchors
every finding to something the runner can verify exists. `verdict` is `revise` if and
only if some finding is a `blocker`, which makes routing mechanical and denies the
model room to hedge; the runner rejects a result that claims `pass` while listing
blockers. There is no field for a revised plan: a reviewer that can rewrite is not
adversarial, it is a second planner. It names problems, planning fixes them.

A card ends in one lane, `done`, with a `doneReason` saying how: `merged`, `poisoned` (an
infrastructure failure, not a quality one), `dropped` (a card source closed its ticket while nothing
was running, or a person dropped it), or `split` (an automatic split replaced the card with its
pieces, which now decide when it is done).

`needs-human` is not a terminal state, or a lane a card is routed to at all. It is a
flag (`needsHuman` on the card, alongside a `needsHumanReason`) that a card carries
while it stays exactly where it failed: retries exhausted, or the budget ceiling
already spent. Routing a flagged card to a lane would throw away the one piece of
information that matters — which stage it was failing in — and `needs-human` used to
be terminal for a worse reason still: `writeTransition` reclaimed the worktree on the
way in, deleting the tree a person would want to look at in the one case where a
person has been asked to look. A flagged card now keeps its worktree, and nothing
reclaims or garbage-collects it.

A card reaches `poisoned` when a stage throws an error that retrying cannot fix:
billing, credentials, a malformed request, a rebase conflict. Such a failure must not
be a kickback. A card's retry budget is for work that came back wrong, and spending it
on an exhausted balance both wastes the budget and misreports the cause — this project
watched a card burn three retry cycles against "credit balance is too low", each one
cutting a worktree and installing dependencies before failing at the first model call.
The job returns normally after poisoning so the queue does not retry it either. A card
that has already ended keeps its ending: a late job records `stage.stale` and sends nothing.

Classification is by message text, because neither the SDK nor the provider surfaces a
stable machine-readable class. It is deliberately conservative: a miss costs a few
retries, a false positive strands a card that would have recovered.

Three modes for a stage, borrowed from AO (github.com/launchapp-dev/ao):
`agent` (spawns a model), `command` (runs a shell command), `manual` (human gate).
Human gates are a first-class stage type, not a special case in the runner.

Review failure moves the card backward with findings appended to the plan and a
retry counter incremented.

### What the reviewer is told before it starts

A lane that reviews gets a `## Machine evidence` section on its plan, worked out after setup and
before the agent starts. It is an input and never a gate: nothing reads it but the reviewer, and
failing to work it out writes "could not compute" and leaves the stage to run.

- **Net-new type errors.** A lane with a `typecheckCommand` has it run on the branch and, only if the
  branch has errors, on a second tree at `baseSha`, cached by `baseSha` and command. Errors compare by
  package, file, code and message, never by line, and are counted, so a second identical error is new.
  Under turbo the command needs `--continue`, or the first failing package cancels the rest and an
  existing error can hide a new one, so without it the section reads "could not compute". A command
  that writes outside ignored files has its writes reverted and reports "could not compute", because
  the review verifier rejects uncommitted paths.
- **Exports nothing references.** Exports the branch adds, by the AST, whose name `git grep` finds
  nowhere outside the file's own declaration, tests and docs. It fails toward silence: a name its own
  file uses, a move between changed files, and files found without an import (entry points, routes,
  migrations, configs) are never listed, and a match is written up as evidence, not a verdict.

All of it fits in `REVIEW_EVIDENCE_DEADLINE_MS` (4 minutes). That time is outside the stage's own wall
clock and comes out of the ten minutes `CARD_STAGE_EXPIRES_IN` leaves around it. Steps of a review lane
inherit its settings but get no evidence. `review.evidence` records the counts on the event log.

### Checked rules

Learnings are advice nothing checks. A **rule** is a statement a person says must hold, with the path
globs it is about and a severity: `wilson.rules`, with every change in `wilson.rule_revisions`, written
through `wilson rules add|edit|rm` or the web's rules page. Rules are machinery (decision 8), so every
write needs step-up and none is offered through MCP. Planning and implementing read them beside the
learnings, so work can meet them before anyone judges it.

At review, beside the evidence, each rule whose globs match a changed path gets its own **judge**
(`RuleJudge`): one fresh, tool-less model call, handed the rule, the plan and that rule's part of the
diff (`git diff --no-renames`), at most three at a time. It shares nothing with the reviewer, so it
cannot be argued out of a rule by the rest of the change or by what the reviewer concluded. The
`rule-judge` setting (`wilson rules route`, or the rules page) names its engine and model, `api` or
`cli`, apart from any lane's routing, so a review lane on `codex` still has judges.

- **A failure with a real `file:line`** on a `blocker` rule is merged into the review's report as a
  blocker before `ReviewVerifier` reads it, and forces `revise`. From there it is an ordinary blocker: it
  goes through `challenge` and kickback like any other, and routing knows nothing about rules. A rule's
  finding starts `Rule <id> failed:`, which keeps its text unique for the challenge's accounting.
- **A failure with no citation that holds up**, or any failure of a `concern` rule, is a concern. A
  citation is only believed if the file is one the judge was shown and the line is in it, so a judge's
  bad citation can never get the review's report rejected. The cap of 20 findings drops the review's
  concerns first, then the rules' concerns.
- **No verdict** is `unavailable`: the engine failed after one retry, the deadline passed, or the
  rule's diff is over `RULE_DIFF_MAX_CHARS`, since a judge reading part of a diff could pass a rule the
  unread part breaks. It is advisory, never blocking, and says so on the plan.

`wilson.rule_verdicts` holds every verdict, keyed by rule revision and diff hash, so a stage sent again
over the same code makes no new calls. An `unavailable` is not reused, and a later answer replaces it.
No rule matching leaves no trace at all. `rule.verdicts` records what was said on the event log with
its `usage`, which counts against the card's budget and in its stats as the stage's, and as no attempt.
All of this shares `REVIEW_PREPARATION_DEADLINE_MS` (5 minutes) with the evidence. Steps get no judges.

`wilson rules check <branch>` asks the same judges about any branch's diff from its merge base, with
nothing on the board moving, and exits 1 when a blocker rule fails. It writes verdicts, so a card over
the same code gets them for free.

A blocker that survives `challenge` and sends a card back can also become a **proposal**:
`card.rule-proposal` asks a fresh model whether it points at a lasting rule, on the judges' route. A card
gets one look however many kickbacks it takes, and most looks should find nothing. A proposal is
`wilson.rule_proposals`, and is nothing until a person names and accepts it (`wilson rules accept`, or the
rules page), behind step-up. It stops being offered after 45 days. Rule failures are never proposed from.

### Measuring the reviewer

Lanes can be re-routed and prompts edited, and neither says whether the change helped.
`pnpm --filter @wilson/api eval:review` scores the real review stage on diffs with a known
answer, so two models or two prompts can be compared on the same cases.

The corpus in `apps/api/evals/review` holds 20 real defects from Wilson's history and 10
controls. Each case runs in a scratch repository of one commit, through the same plan file,
scope guard, adapter and `ReviewVerifier` a stage uses, with no board or database. Recall
and specificity are reported with their `n`, both as the model reported them and as the
verifier would have them.

These scores stop at review, so they overstate what survives `challenge`. Type-check evidence,
rule judges and learnings do not run. A scratch repository is not a sandbox: a reviewer's
allowed commands run on this machine and can reach its test database. The live prompt is only
in the database, so a run takes a labelled copy of it. Real runs spend model usage, so they are
started by hand and never by CI. `apps/api/evals/review/README.md` has the method and how to read a result.

### Before the work: parking lot, planning, backlog

Three lanes sit ahead of `implementing`, and none of them is dispatched. Together they
are where a thought becomes a contract, with a human gate at each end.

**Parking lot** — ideas to remember and plan later, and a place to point at. Not a
stage; a column the dispatch query excludes. Cards there are stubs: a title and a
note, no plan, no branch, no worktree, never claimed by a job. It exists so a thought
can be captured mid-review without becoming work.

Its second job matters as much as its first: **a parked card is a durable reference.**
Other cards cite it by id — "the rails it is gated behind", "this is the cheap version
of what card 0027 wants" — and that citation stays meaningful whether or not anyone
ever implements it. A parked card is not only queued work; it is a named idea the rest
of the board can refer to.

**Planning** — cards being planned, by a human and an agent together. `mode: manual`,
because the queue must never dispatch it: the stage is a conversation, and there is
nothing for pg-boss to carry. `wilson card plan` drives it, reading this stage's model
and instructions from config, and it ends when a plan filling the six contract
headings is written as a new card version.

**Backlog** — plans approved, checked and waiting to be worked. Also `mode: manual`.
Approving pins `planVersionId`, so the version every downstream stage reads is the one a
person actually approved, and the scope check has judged that same version by the time a
card lands here. The poller then moves it on, as capacity allows and Auto-mode permits.

The human gates are therefore three: promoting out of the parking lot, approving a plan,
and merging at `ready`. Everything between the second and third runs unattended.

### Per-stage model routing

Model and provider are properties of the stage, not a per-task choice. Defaults:

- planning and adversarial plan review: the strongest available model
- implementing: strong model, full tool access
- testing: mid-tier
- code review: strong model, read-only tools

Each project routes its stages to a provider and model — Anthropic, OpenAI, or xAI —
since they are one `ToolLoopAgent` model argument apart. Routing lives in
`wilson.stage_routing`, apart from the stage config document, so one stage can change
without rewriting it (`wilson stages route`, or Settings in the web app). Provider
credentials are per-deployment, not per-project.

A lane can also scale with the card's diff. Its optional `depths` is a ladder of
`{ minChangedLines, model?, maxSteps?, maxInputTokens? }`, smallest first. The highest tier the
diff reaches applies, measured as lines added plus removed from `merge-base..branch` on this
machine before the rebase. A diff below every tier, or one that can't be measured, runs the lane
as written. A step such as `challenge` always runs on the lane's own model, an interrupted stage
goes back on the tier it started on, and `stage.dispatched` records the tier. `maxInputTokens` is
cost-weighted here as everywhere. No lane should turn this on without a comparison from the
reviewer measurement in `apps/api/evals/review/`.

The adversarial reviewer reads the plan cold, with no access to the planning
conversation, and emits `{verdict, findings[]}`.

### Whose work a stage is judged on

Two different questions, and conflating them strands cards.

`changedPaths` measures from the fork point, so it describes **the card**: everything
it has changed across every stage. That is the right basis for a review's finding
provenance, which is a claim about the card's diff.

The fork point is `Worktree.baseSha`: the commit `create` cut the branch from, kept
current on a resumed branch by `rebaseOntoHead`. It is the one basis every verifier
measures a card's diff against, and it is what the runner tells the agent to run
`git diff` against — a two-dot `git diff main` is not the same thing on a branch whose
base has moved, since main's newer commits then render as deletions on the card's own
branch rather than as the unrelated changes they are.

`uncommittedPaths` describes **this stage's own work**. Since a stage only commits on
pass, at verification time what it wrote is exactly what is uncommitted. That is the
right basis for scope enforcement.

Checking the card's whole diff against the current stage's scope holds a stage
responsible for files a later one is supposed to add, and the card cannot escape:
every retry fails identically on inherited work. Card 0014 kicked back from testing
to implementing and then failed three times on test files the testing stage had every
right to write, escalating to `needs-human` over a rule rather than over the work. The
escalation was correct; the rule was wrong.

### Why the exit conditions are shaped this way

Every exit condition an agent can satisfy by doing less work is a condition it will
eventually satisfy by doing less work. `build passes` alone is satisfied by an empty
diff. `suite green` alone is satisfied by deleting tests. The extra clauses are the
cheap mechanical guards, and the strongest is requiring new tests to fail against
the pre-change tree — a test that passes before the change tests nothing.

The review verdict is the one result a machine cannot judge on merit. So the runner
never checks the verdict, only its shape and provenance: schema-valid, findings
anchored to lines that exist in this card's diff, severity from a closed enum. Given
a well-formed result, routing is mechanical. If single-model verdicts prove flaky,
run N reviewers and require a majority to kick back.

## Interactive planning

The planning stage is a conversation, not a batch job. The web app renders the draft
plan beside a chat panel and streams the agent's output as it writes.

- **Session-backed.** One planning session per card, streamed over SSE. Sessions
  survive process restarts and reconnects; the client resumes by `Last-Event-ID`.
- **Two feedback channels.** Overall feedback goes to the chat. Targeted feedback
  comes from selecting a passage of the plan and commenting on it.
- **Anchors are quote-based, not offsets.** A comment stores the exact quoted text
  plus a prefix and suffix window, so it survives the agent rewriting the paragraphs
  around it. When a quote can no longer be located after a revision, the comment
  surfaces as outdated rather than silently reattaching to the wrong line.
- **Comments are input, not contract.** On the next turn, open comments are handed
  to the agent as anchored instructions, and a client can submit them as a turn of
  their own. A turn that finishes resolves the comments it delivered, so each is sent
  once; resolved means delivered, not addressed, and reopening one sends it again.
  Per decision 4, only the resulting plan text binds downstream stages — the thread
  is not carried into implementation.
- **Approval is explicit and versioned.** Approving writes a card version and pins the
  card to it. That version, not the live document, is what every downstream stage reads.

## Board schema

A card is a row. Column membership is a column, so a transition is one `UPDATE` inside
the same transaction that writes its event — the property the old two-store split could
not provide.

```
projects        id, name, code_root, worktree_root, port_range, ...
wilson.cards    (project, id) PK, title, stage, branch, body, retries,
                external, source_closed, position, pinned_version_id, created_at
wilson.card_deps       (project, card_id, depends_on_id) — FK both ways
wilson.card_versions   id, project, card_id, frontmatter, body, message, created_at
wilson.card_events     append-only; every claim, denial, grant and transition
```

`wilson.cards` is current state — what `card list` and dispatch read. `wilson.card_versions`
is append-only history: the replacement for `git log` on the board repo, carrying the
message that used to be the commit message (`0018: implementing -> testing`).

**Card ids stay sequential and human-readable.** `0042` is typed into CLI commands,
appears in branch names (`card/0042-port-allocator`) and is read in `dependsOn`. The
primary key makes a duplicate an error rather than a casualty — the file-backed board
used `writeFile`, which overwrites, and a real card was destroyed that way. Hash ids are
the right answer when writers are separated by git remotes; they are unnecessary when
writers are separated by a transaction.

**A version snapshots the whole card, not just the plan body.** `readAt` replaces
`git show <sha>:<path>`, and the dispatcher reads frontmatter from the pinned card —
`assertDispatchable` checks its stage and `dependsOn`, and the branch name comes from its
title. Storing only the body would silently change dispatch semantics.

**The plan is a version, not a file.** `cards.pinned_version_id` points at the version
approved at plan-approval, and every downstream stage reads that version rather than the
newest one. This is exactly what `plan_sha` bought, and it preserves decision 4 unchanged:
"the plan file is the contract" becomes "the approved plan version is the contract", still
a specific immutable version, now without git in the read path.

**Dispatch materializes the plan to a file.** Unchanged in effect: at dispatch the runner
writes the approved version to `/run/cards/<id>/plan.md`, outside the worktree, and passes
that absolute path to the agent. Outside, so it cannot be committed to the card branch; a
file, because that is what the agent reads.

**Ordering is a column.** `cards.position` orders the parking lot. With the shared-index
constraint retired there is nothing clever to do here — no fractional ranks, no merge
semantics. A reorder is one `UPDATE` per moved card in one transaction.

**Lanes are rows too**: `wilson.lanes`, one row per lane per project, with the fields something
reads or edits on its own as columns and the rest in `settings`, which holds only what someone
chose, so a default stays a default. What a project's lanes share is in
`wilson.project_lane_settings`, and every change to either adds to `wilson.lane_revisions`. They
are validated on every write and read, and are machinery, not board state: human-write-only
(decision 8), and reachable only through `/api/stages/lanes` and `/api/stages/routing`, which no
agent runs with, since the bash tool is an argv allowlist and the board is unreachable from a
worktree by construction.

`wilson.stage_configs` and `wilson.stage_routing` are what lanes were before, kept unread but for a
one-time import at startup. The YAML's commentary is only there. The sibling board repo that held
the file is gone, and `boardRoot` with it.

## Scope enforcement

`Files in scope` holds globs, not paths — `src/runner/**`, `test/runner/**` — so a
plan does not have to predict every file it will create. The write tool allows a
path when it matches a scope glob and no deny glob. The deny list always contains
`.runner/**` and stage config (decisions 6 and 8) — board paths no longer exist in a
worktree to deny. Each project's
config adds an `always_allowed` list for generated and machine-owned files that no
plan should have to mention — `pnpm-lock.yaml`, `src/generated/**`.

**Generated but tracked is the trap, and this repo has two.** A file that is
regenerated by a tool _and_ committed will pass every check an agent runs by hand
and still fail the build, because the checked-in copy is what `tsc` reads. Card 0032
failed its exit condition editing `apps/api/data/contracts/board.ck` without running
`pnpm codegen`, leaving `src/generated/**` and `board.router.ts` stale. Card 0151
failed three times adding routes under `apps/web/src/routes/`: the TanStack Router
plugin regenerates `apps/web/src/routeTree.gen.ts`, which is tracked, and the
uncommitted tree left every `params` typed against `AnyRouter` — six `TS2353` errors
in files the card had not touched. A card that adds a contract operation or an app
route should say so in its plan, name the generated file, and treat `pnpm build`
passing — `tsc` included — as the thing that proves it.

**The last look before a commit.** The write tool stops the writes it sees, and an engine or a
command can write without it. So before a passing stage commits, whichever engine ran it, the
dispatcher checks everything uncommitted against that stage's scope, and compares the tree with a
snapshot taken when the verifier finished. A path outside scope, or anything changed since the
verifier finished, fails the stage and commits nothing. The configured test report is exempt from the scope check, being the
runner's own output.

When an agent genuinely needs a file outside scope, it cannot write it. It calls a
`request_scope` tool with the path and a reason, and the project's
`scope_violation` policy decides:

- `widen` — the request is granted for this run and appended to the card's event
  log. The exit condition then evaluates against the original scope _plus_ granted
  widenings, and the review stage sees the widenings as facts about the run. An
  auditable bypass, not a silent one.
- `kickback` — the stage fails and returns to planning with the requested path
  attached, on the theory that a plan which did not anticipate the file was wrong.

Start on `widen` while plans are still unreliable; tighten to `kickback` once they
are not.

## The operator's escape hatch

There is no out-of-band edit path to reconcile, which removes the filesystem watcher, the
re-parse, the `external_transition` event, and the lost-update race between the daemon and
a text editor.

What it does not remove is the need to fix a wedged card by hand. `wilson card edit <id>`
opens the plan body in `$EDITOR` and saves it as a new version; `wilson card move <id>
<stage>` remains the operator override, recorded as a `transition.written` event with
`by: human`. A stage already running when the card moves is not interrupted: it finishes, sees the
card has left its stage, records `stage.stale` and writes no transition, so the human's move stands.
If the move was to a terminal stage, that run is what reclaims the worktree.

Frontmatter is deliberately not editable through `card edit`: stage, branch and retries are
runner state (decision 5), and `card move` is the recorded way to override one.

## Authentication

Decision 10 in practice. The design follows deadair's, which runs on the same Koa ServerKit
stack, using `@maroonedsoftware/authentication`, `policies` and the `authenticationMiddleware` /
`requirePolicy` pair `@maroonedsoftware/koa` already ships. ats was the other reference. Its
SSO, SCIM, org row-level security, ReBAC tenancy and OAuth authorization server solve a
multi-tenant problem wilson does not have, and are deliberately left out.

**Principals.** There are two:

- **The operator account.** Exactly one human account, signed in to with an email address (wilson
  never sends mail to it, so it needs no mail setup), created through first-run onboarding:
  `GET/POST /onboarding` is unauthenticated, takes a transaction-scoped advisory lock, re-checks
  that no account exists, and refuses with 409 once one does. There is no sign-up and no
  invitation flow. `GET /onboarding` answers with what first run still needs, as a list of
  requirements after deadair's (only `account` today), so a later first-run step joins the list
  rather than adding a field. The web app shows onboarding while `account` is listed, and so does
  `wilson board init`: on a fresh install its call answers 401, so it creates the account from the
  terminal (or signs in to the one there is), stores this machine's key, and tries again.
- **API keys.** `wl_`-prefixed and stored only as a SHA-256 hash with a short display hint, with an
  optional expiry and a `revoked_at`. Scope is `view` or `manage` (manage implies view), and a key
  can never exceed its owner's authority. The CLI uses one, and so does any script.

**Sessions.** Every login method goes through `POST /auth/token` with a `grant_type`. The access
token is an RS256 JWT that names a server-side session, so revoking the session invalidates every
token derived from it. Sessions live in the Postgres-backed cache wilson already runs
(`cache_entries`, plus `cache_set_members` for each account's index of its sessions), so
authentication adds no Redis. Refresh tokens are single-use and rotate within a family; replaying
a spent one revokes the family.

The signing key is `AUTH_SESSION_PRIVATE_KEY` when set, as a PEM or base64. Otherwise it is read
from `AUTH_SESSION_KEY_FILE`, default `../.wilson-secrets/session.pem` beside the repo as
`WILSON_BACKUP_DIR` is, and generated there, owner-only, on first boot, the way deadair's container
generates its keys. Refusing to boot without one would be stricter, but the CLI builds the same
container, so an unset key would stop every `wilson` command and the daemon's next restart.

**Factors.** A password (Argon2id, rate-limited per account) is the first factor.
An authenticator app (TOTP) and passkeys are the second. With one enrolled, a correct password
answers `mfa_required` with a five-minute challenge instead of a session, and the `authenticator`
grant completes it with a code; each code works once. The TOTP seed is stored encrypted under a
root key (`AUTH_ENCRYPTION_KEY`, or generated into `../.wilson-secrets/encryption.key` like the
signing key), because a code can only be checked against the seed itself. Lose that key and every
enrolled authenticator stops working, so back it up with the database.

A passkey completes the same challenge through the `passkey` grant, after
`POST /api/auth/passkey/challenge` issues a WebAuthn challenge for the browser to sign. A passkey is
bound to the origin it was made at, and the API takes that origin from the request only when it is
one of `WEB_ORIGINS`, so a page anywhere else is never handed a challenge one of ours would answer.
Passkeys work only in the web app, which has a browser: the CLI completes a sign-in with the
authenticator app, and tells a passkey-only account to set one up as well. Step-up, meaning a strong factor proven within the last five
minutes, guards minting an API key, editing lanes (`wilson stages set`, `instructions`, `route`), and
saying which machine receives card work and engine tokens (`wilson host add`, `host set
--ssh-target`, `host token`, `host engine-token`), because those are the actions that hand out or
rewrite authority. An API-key session never satisfies step-up (`wilson.step.up`, which answers a key with `step_up_unavailable`), so the CLI
answers that refusal by asking for the password and making that one call with a fresh session,
signed out again straight after. A leaked key can read the stage config and cannot rewrite it, and
cannot register a worker to be sent repository contents and engine tokens.
Until a second factor is enrolled, a password proved within the window is the step-up; after, only
the second factor is, so a stolen password cannot remove the authenticator meant to stop it. Adding
or removing a factor is itself behind step-up, and the web app asks for it in a "confirm it's you"
dialog when its session is older than the window.

**Transport.** The web app holds the access token in memory, never in storage a script could
read, and sends it as a bearer header. It opts into cookies with `x-wilson-cookies: 1`, and the API
then sets two httpOnly, SameSite=Strict cookies instead of returning the refresh token in the body:

- `wilson_rt`, the refresh token, scoped to `/api/auth`, so only `/api/auth/token` and
  `/api/auth/logout` ever receive it. A reload signs back in by redeeming it.
- `wilson_at`, the access token, which the two read-only event streams (`GET /api/feed`,
  `GET /api/cards/{id}/plan/stream`) accept in place of a header, because the browser's
  `EventSource` cannot send one. Every other route ignores it. An open stream ends when the session
  or key it was opened with is revoked, since it makes no later request that could be refused.

That is why there is no CSRF token: no route that changes anything accepts a cookie as a
credential. CORS admits only the exact origins in `WEB_ORIGINS` (default the dev web app,
`http://localhost:13101`), with credentials, since admitting any other origin would let a page
there redeem the refresh cookie and read the access token it returns. The CLI and scripts never
opt into cookies and get the refresh token in the body. The CLI keeps an API key in the OS keyring
(`@maroonedsoftware/johnny5/keyring`): `wilson auth login` signs in with the password, mints a key
named for the host, and signs the password session out again; `logout` / `status` / `token`
manage it, and `WILSON_API_KEY` overrides it for scripts. The Android app does the same as the CLI at
the token endpoint, keeping the refresh token in app-private storage. It signs in with a password
and an authenticator code; passkeys work only in the web app for now.

**Enforcement.** Every `.ck` operation is gated by default. An operation with no `security`
block requires an authenticated session. Public routes, which are health, onboarding and the
auth endpoints, say `security: none` explicitly. A coverage test fails the suite when a route
is neither gated nor explicitly public. Each request also confirms the session's account still
exists, so a database restored out of step with the session store cannot serve a deleted
principal.

**What this does not cover.** Authentication guards the HTTP API. Every `wilson` command reaches
the board through it (card 0085 moved the last one, `card plan`, off a container of its own); the
only CLI code that opens a database connection is three `wilson doctor` checks, and they ask only
whether Postgres answers, whether pg-boss's schema exists, and which migrations the test database
has, never a board row. Two other paths do reach board state without the API:

- **The database itself.** The `cli` engine strips `DATABASE_*` from a stage's environment, but
  the compose credentials are the image defaults and project code can hard-code them.
- **Files the operator's user can read.** A stage runs as the same OS user as the daemon, so
  project code it runs can read the signing key file, `apps/api/.env` and anything else that user
  can, unless the engine's own filesystem sandbox stops it (the `cli` engine's can; the `api`
  engine's bash tool has none). With the signing key, code can mint a session. Taking the route
  away from a stage is what this design does. Taking the files away needs a different OS user
  or a container boundary, and is its own card.

No stage inherits wilson's own credentials through its environment. The `api` engine's commands
run with an allowlist of nine variables (`scrubbedEnv`), which none of them is on. The `cli` engine
copies the daemon's environment and strips what must not pass (`subscriptionEnv`): `DATABASE_*`,
and now `AUTH_*` (the signing and encryption keys, which dotenv loads from `.env`) and
`WILSON_API_KEY`. Tests pin both by name. What an environment scrub cannot reach is the OS keyring
holding the CLI's key: it belongs to the operator's user, which is the files gap above again. `wilson
doctor` gains `signed in to the API`, so a machine with no key, or a revoked one, says so once with
the fix instead of on every command.

**Rollout.** One commit per step, each leaving the tree working:

1. Record decision 10 and this section (documentation only).
2. Wire the authentication module: dependencies, signing-key config and the cache-backed
   session store. Nothing is enforced.
3. Add the account and factor tables, onboarding, the password and refresh grants,
   `/auth/session` and `/auth/logout`. Nothing is enforced.
4. Add API keys, with routes to create, rotate and revoke them, and `wilson auth`. The CLI
   sends a bearer when it has one. Nothing is enforced.
5. Add the web onboarding and login pages, the root-route gate, the session cookies, a single
   retry on 401, the stream cookie for the event streams, and exact-origin CORS with credentials
   (it cannot wait for step 6: credentialed CORS for any other origin would expose the refresh
   cookie). Nothing is enforced.
6. Turn on enforcement: default policies on every contract, `security: none` on the public
   routes, and the coverage test. After this commit an unauthenticated request gets a 401.
7. Add TOTP and passkeys, and step-up for key minting and stage config edits.
8. Settle the CLI's direct-database commands. There were none to settle: every command already
   goes through the API, and the doctor's database checks read no board state. This step corrects
   the note above, which had said otherwise.
9. Extend the `cli` engine's environment scrub to wilson's credentials, and add the doctor check
   that this machine is signed in.

Steps 2 to 5 add capability without changing who can call what. Step 6 is the one commit that
changes behaviour, so the rollout can stop before it. Changing the database password is its own
card.

**Upgrading a running deployment past step 6.** Every caller needs a credential from then on, so,
in order: run `pnpm migrate:up` (the accounts, keys and cache-set tables); restart the API; open the
web app, which shows onboarding the first time, and create the account (or let `wilson board init`
create it from the terminal); then run `wilson auth login` on each other machine that uses the CLI. Until the last step, CLI commands answer "not signed in" rather
than reaching the board. `GET /api/health` stays open, so `wilson doctor`'s liveness check works
throughout.

## Notification

`Notifier` posts JSON to one webhook, `notifyWebhookUrl`, off when it is unset. No delivery guarantee
beyond at-most-once.

A notification is sent inline, once the write it reports has committed, and a failure is logged and
swallowed, so a webhook outage cannot fail a transition.

Six moments only (`NotifyMoment`), each naming what the reader is being asked to do, because anything
more and the operator learns to ignore them:

- `manual`: a card enters a `manual` stage and is waiting on a human
- `needs-human`: a card is flagged, by exhausted retries or a spent budget
- `needs-answer`: a stage stopped to ask one question, which is the message's `reason`
- `poisoned`: a card dead-letters
- `source-closed`: a card's ticket closed upstream
- `auto-split`: a refusal retired a card in favour of pieces waiting in `planning`

A webhook message deep-links to the card in the web app when `notifyBaseUrl` is set.

Push to the Android app is a second channel beside the webhook, registered with `Notifier` at boot
and off unless `FCM_SERVICE_ACCOUNT_FILE` names a Firebase service-account file. It needs no webhook:
callers always go through `Notifier`, which decides what is on. Delivery is
at-most-once, like the webhook, and a failure can never reach a stage. Phones sign up through
`POST /api/devices`, and FCM reporting a token `UNREGISTERED` removes it from `wilson.push_devices`.
A message carries only the moment, the project and the card id, so card titles and failure reasons
never pass through Google; the app fetches the title over its own session when the message lands.

## Card granularity

A card is the unit of work one agent can finish against one plan without needing to
talk to another agent. In practice that means a vertical slice behind a stable
interface, and two cards can run in parallel exactly when neither needs an interface
the other is still inventing.

When several cards share a new interface, the interface is its own card and lands
first. ContractKit makes this the natural decomposition anyway: card 1 writes the
`.ck` contract, cards 2–n implement against the generated types. That keeps
dependency chains one deep with fan-out at the leaves, so the concurrency cap binds
before `depends_on` does.

The honest limitation: work that cannot be decomposed behind an interface — a
refactor touching everything — is one large card, and this system gives it no
parallelism at all. That is accepted, not solved.

## Plugins

Linear tickets and Slack threads are two different extension points, not one. A
ticket source is a stateful bidirectional sync with identity mapping and webhooks; a
thread fetch is a stateless one-shot read. One abstraction covering both would be
bad at both, so there are three narrow seams instead.

A plugin is a `ServerKitModule` that registers handlers into a DI handler map — the
same idiom the MCP package uses for tools and resources. Modules are listed in
config and resolved at boot, in-process. This is deliberately **not** a third-party
ecosystem: single operator, self-hosted, plugins are modules you write. That removes
sandboxing, permission grants, and version negotiation from scope entirely.

Plugin credentials come from appconfig `${...}` resolvers, per deployment rather
than per project.

### Card sources

Create and update cards from an external system: Linear, GitHub Issues, email. A
source runs either as a jobbroker scheduled poll or behind a webhook route, and
writes through the API like everything else (decision 3) — never straight to disk.

- **Inbound authority only.** The source may create cards and update descriptive
  fields. `stage`, `branch`, and `retries` stay ours (decision 5) and flow _outward_
  to the external system as a status mirror. Two systems of record is the failure
  mode here, and one-way authority with two-way data is what avoids it. This is the
  same rule as human filesystem edits, applied to a different writer.
- **The external ref is a column** — `cards.external` as `{ linear: 'ENG-123' }` — so
  the mapping is queryable and indexed, and a source's inbound updates hit one row.
- **Import is opt-in, not firehose.** A source config names a label, view, or query.
  Mirroring an entire Linear workspace onto the board floods it with cards that will
  never be planned.
- **Deliveries are deduplicated** with `IdempotencyStore` from
  `@maroonedsoftware/cache`, keyed by the source's own event id. Webhooks are
  at-least-once and polls overlap on restart.

**When the ticket is closed externally mid-pipeline**, the source cannot cancel the
card — it has no authority over board state. It records `source_closed: true` and
notifies. What happens next depends on whether anything is running:

- parking lot or a `manual` stage — nothing is in flight, so the card moves to
  `dropped`, a terminal state. There is nothing to lose.
- a stage is executing — let it finish, then halt at the next transition into
  `needs-human` with reason `source-closed`. Killing mid-stage forfeits spend already
  incurred and leaves a half-written worktree; one more stage is bounded by that
  stage's budget.
- never auto-merge a card whose ticket is closed. The `ready` gate is exactly where a
  human decides to ship it anyway or drop it.

### Context providers

Fetch a document and attach it to a card as planning input: a Slack thread, a Linear
comment chain, a Notion page, a URL.

**Snapshot at attach time; never fetch live during planning.** The provider pulls
the content once, stores it against the card, and the planning agent reads the snapshot. A live fetch would make planning unreproducible — the
thread keeps moving, and a re-run after a kickback sees different input than the run
that produced the plan. This is the same instinct as pinning the plan version: pin the input, then
reason about it. It also means context survives the thread being deleted.

Attach is a human action in the web app, or a card source can attach automatically
(the Linear ticket that created the card brings its own description and comments).

Snapshots are rows, not files in the code repo — which is most of what makes this
comfortable, since the database is operator-private by construction while the code repo is
the one that gets shared. Retention is the default because reproducibility is the entire
reason for snapshotting: the plan's input pinned beside the plan. Two limits on that:

- Store only what planning needs — message text, author display name, timestamp —
  behind a manifest recording source URL, fetched-at, and who fetched it. Not
  emails, not account ids, not attachments.
- A per-project `context.retain: keep | ephemeral` toggle. Under `ephemeral` the snapshot
  expires on a TTL and the card keeps only the source URL and a content hash, accepting
  that a re-run after expiry cannot reproduce its input. For a project where even trimmed
  third-party text should not be retained, losing reproducibility is the right trade.

### Notification channels

A `NotificationChannel` beside the webhook, registered with `Notifier` at boot, as push is — see
Notification.

### Imported content is untrusted

A Slack thread or a Linear ticket is text written by someone who is not operating
this system, and it flows into a planning agent whose output an implementing agent
executes. Treat it as data, always:

- Context snapshots are delimited as quoted material in the prompt, never
  concatenated as instructions.
- A plan is still gated by explicit human approval before anything runs:
  `wilson card approve`, or the app's own diff-and-confirm, pins the plan version
  and moves the card from `planning` into `backlog`. Not by `plan-review`, which
  the stage model above describes and which was never built (see Build order); the
  gate here is a person reading the plan, which is the stronger of the two anyway
  for input the operator did not write.
- The write tool's scope enforcement is the actual backstop. A plan steered somewhere
  it should not go still cannot write outside its globs without `request_scope`, and
  that request is logged and visible.

Worth stating plainly because this is the one feature that opens the pipeline to
input the operator did not write.

## Runner requirements

- **Worktree lifecycle.** Create per card under the project's worktree root,
  garbage collect on completion, reclaim on job failure. Twenty active cards should
  not leave twenty stale worktree directories.
- **Port allocation.** Inject a unique port per worktree from the project's
  configured range so dev servers across parallel cards do not collide. Allocate by
  checking the port is actually free, not by hashing the card id; release on
  completion or job failure. The range must be published from the container or the
  injected port is unreachable from a browser.
- **Concurrency cap.** Per project and global maximums of simultaneously dispatched
  cards.
- **Budget caps.** Per-card and per-stage token and wall-clock ceilings, enforced
  through `stopWhen` and the runner. Retry limits bound the loop count; they do not
  bound the spend.
- **Agent sandbox.** Tools are the boundary, so the tool implementations enforce it:
  writes confined to the worktree and to the plan's files in scope, board paths and
  `.runner/` rejected, and the bash tool's environment scrubbed of git and provider
  credentials. No agent holds push access to main.
- **Dependency blocking.** `depends_on` is a hard block. A card whose dependency is
  unfinished must not dispatch, because file-based coordination cannot carry an
  in-flight API contract between two running agents. Reject dependency cycles at
  load time.
- **Dry run by default.** The pipeline runs end to end, merges into a throwaway
  integration branch, and withholds only the write to main, logging the intended
  merge instead. Merging in dry run is what lets dependent cards dispatch — withhold
  the merge entirely and no dependency chain ever runs, so the supervised clean pass
  you need before disabling dry run could never cover one. Ship with dry run on.
  Turn it off only after supervising a full clean pass including a dependent card.
- **Structured output.** Every stage result is an `Output.object` validated against
  the stage's schema. Prose in stdout is not a stage result.
- **Observability.** Serverfeed carries progress, status, and errors per card, with
  latest-per-key snapshots so a client renders current state without replaying.
  A johnny5 command answers why a given card is not moving: current stage, job
  state, time in state, last verdict, retry count.

## Deployment

Two ways to run it. On a development machine, `docker-compose.yml` runs Postgres (and the test
database and the backup) and the API runs from the checkout (`pnpm --filter @wilson/api start`).
On a server, `docker-compose.unraid.yml` runs the whole orchestrator in containers, and the stages
that touch a worktree run on workers.

### Reaching it from a public host

The Android app talks to the API directly and push does not need it reachable, but a phone away from
home does, so the stack can sit behind a public HTTPS host. Decision 10 is what makes that safe:
every API request is authenticated. What the host must do:

- **HTTPS only.** Terminate TLS at the proxy or tunnel, in front of the published web port. Release
  builds of the app refuse plain http.
- **Create the account first.** Onboarding is unauthenticated until an account exists, so finish it
  before the host goes public, or anyone can claim the board.
- **Add the address to `WEB_ORIGINS`**, and use it for `NOTIFY_BASE_URL`, so passkeys and links keep
  working there. The app itself is not a browser and is not held to `WEB_ORIGINS`.
- **Leave streams and merges alone.** Turn off response buffering on `/api/`, and keep idle and read
  timeouts well over 20 seconds for streams and over 20 minutes for a merge, or a planning turn or a
  chat turn. `deploy/web.nginx.conf` already does this; a proxy in front of it has to as well, and a
  heartbeat crosses the stream every 15 seconds. Longer calls can outlast a tunnel's own limit, in
  which case the app reports a lost merge as unknown and re-reads the card.
- **Expose `/` and `/api/` only if you want workers to connect from outside.** Workers hold a
  WebSocket at `/api/workers/connect`, so a proxy that serves them must allow upgrades there. A proxy
  that does not need them can refuse that path.
- **Push is outbound.** `FCM_SERVICE_ACCOUNT_FILE` needs the container to reach `oauth2.googleapis.com`
  and `fcm.googleapis.com`, and nothing inbound. Keep the file with the other secrets, under
  `/data/secrets`.

### The server stack

`Dockerfile` builds two images from one tree. `api` is the API and daemon: it migrates the database
on every start, then boots, and carries the pinned `claude` that planning sessions and any `local`
stage start. `web` is the web app, served by nginx, which proxies `/api` to the API so the browser sees
one origin on one port. `docker-compose.unraid.yml` runs both with Postgres and the nightly backup, as
compose project `wilson`, separate from the development stack's `kanban`. The one file to fill in is
`deploy/unraid.env.example`, copied into the appdata folder.

- **Configured by its environment.** The API reads the process environment beneath
  `apps/api/.env`, so a container with no `.env` is configured by `-e` and `env_file` alone, and a
  checkout with one behaves as it always has.
- **Everything kept is bind-mounted** under `WILSON_APPDATA`: Postgres's data, the backups, the
  worktree and run roots, the generated session and encryption keys, the Claude login and a home
  folder. On Unraid that means the cache pool, not `/mnt/user`, whose user-share layer is slow for
  Postgres and for git's many small files. The containers run as `nobody:users` (99:100) so the
  shares stay usable from outside them, and a one-shot `init` service creates the API's folders
  and hands them to that user before it starts.
- **Code repos are mounted volumes.** The clones the daemon merges into live under
  `WILSON_PROJECTS`, one folder per project. Their owner is not the container's user, so the stack
  sets `safe.directory` for git rather than have it refuse them.
- **Model-written code runs on workers, not in the stack.** Placing every worktree stage `remote` in
  the stage config keeps it off the server altogether. What still runs in the `api` container is the
  engine for planning sessions and for stages without a worktree. `local-stage-slots` cannot be 0
  for that reason; `placement` is the switch.
- **Never the Docker socket.** A project whose test suite needs containers cannot be driven by this
  runner yet. Revisit with a rootless Docker-in-Docker sidecar, or on a worker whose machine has
  Docker of its own, if that becomes binding. Mounting the host's socket would hand model-authored
  code root on the server and defeat every other boundary here.
- **The board is reached over the LAN, signed in,** and workers connect to the same port.
  `WEB_ORIGINS` is set to the board's exact address, which passkeys are held to. Over plain HTTP, sessions work but passkeys do not: browsers allow WebAuthn
  only on HTTPS or localhost. Put a TLS proxy in front, or reach it over Tailscale's HTTPS, to use
  them.

### The single image

The same pieces also come as one container, which is what the Unraid template
(`unraid/wilson.xml`) installs. Two variants,
both from `Dockerfile`: `full` carries PostgreSQL 17 and the nightly backup, for a server with
nothing else on it, and `slim` is the same without them, for a database you already run and back up.
Wilson has no Redis, so there is nothing else to leave out.

- **One port, one `/data`.** nginx serves the web app and proxies `/api`, as in the compose stack.
  Everything kept is under `/data`; clones are under `/projects`.
- **`deploy/entrypoint.sh` is the supervisor.** It starts as root to set up `/data`, then drops to
  `PUID:PGID`. Nothing restarts a single service: if one stops, the container stops and its restart
  policy brings all of it back, which is the recovery a daemon holding stages needs anyway.
- **A blank `DATABASE_HOST` on `full` means the database inside.** Its password is generated into
  `/data/secrets` on first boot and it listens on loopback only. `slim` refuses to start without one.
- **`slim` has no backup.** Backing up a database you brought is yours to arrange.
- **Old images pile up on a deploy.** Each leaves a `slim-<sha>` tag and an untagged build of about
  1.6 GB, and Unraid's Docker disk is a fixed size shared with every other container. Before pulling,
  run `deploy/prune.images.sh` on the host (its header has the command). It removes old tags and this
  image's untagged builds one at a time and never runs a prune, since a volume can hold data with no
  container attached.

### Following GitHub `main`

A deployment's image and its project clone move separately: deploying replaces the image and leaves
`/projects/<name>` where it was, and cards are cut from that clone. While dry run is on, a Wilson
merge lands on `dry-run-integration` and never on `main`, so nothing moves the clone but an operator.
GitHub's `main` is the only place `main` changes, and a clone's `main` only ever fast-forwards.

To bring a clone up to date, drain first, then run git inside the container as its own user. Root on
the host would leave root-owned files in the clone:

```sh
docker exec -u 99:100 wilson git -C /projects/wilson fetch origin
docker exec -u 99:100 wilson git -C /projects/wilson merge --ff-only origin/main
docker exec -u 99:100 wilson git -C /projects/wilson branch -f dry-run-integration main
```

Resetting `dry-run-integration` drops any rehearsal that has not reached GitHub, so land those first.
A refused fast-forward means `main` holds something GitHub does not: find out what before going on.
Never run `git worktree prune` from the host, where worktrees under `/data` look prunable but are not.

A card in `ready` reaches GitHub as a pull request, from a machine that can push, since the stack
holds no forge write credential:

1. Copy the branch off the clone with `git bundle create - <branch> ^<base>` and fetch the bundle.
2. Rebase it onto `main`, resolving any conflict, and run the suite. A migration whose version is
   not newer than everything on `main` gets a new one, because dbmate tracks only the version.
3. Open the pull request and merge it once CI passes.
4. Fast-forward the clone as above, then run `wilson card move <id> merged`, which reclaims the
   card's worktree.

Test databases keep the versions of every branch that ran against them. A wipe is needed when an
applied migration file changes under the same version, since dbmate will not apply it again. While
drained, drop and recreate `wilson_test` on each, and the next suite migrates it.

### Workers

A worker is `apps/worker` on a machine kept for it, set up as `apps/worker/README.md` describes:
register the host with `wilson host add <name> --worker`, mint its token with `wilson host token`,
say where each project's clone is with `wilson host serve`, assign it an engine token with
`wilson host engine-token`, and start the worker with `WILSON_URL` and `WILSON_WORKER_TOKEN`. It reconnects by itself and exits for good
only when retrying cannot help.

- **Toolchains are declared, not discovered,** and live on the workers. Each registered project
  declares its required runtimes and a `setup` command run once at worktree creation, and a worker's
  machine carries them. The probe checks what it can (`claude`, each clone, each `commandEnv`
  variable) before placement will choose the host. The `api` image needs only what planning and
  merges do: Node, pnpm and git. A merge check still runs the suite on the daemon's machine, so a
  deployment there needs a test database of its own, named by `TEST_DATABASE_*`. The `worker` image
  starts one itself.
- **A published port range** maps the per-worktree dev server ports out from wherever the stage runs.
- **Git credentials belong to the runner, not to agents.** Wilson merges into its own clones and
  never pushes to a forge, so the stack holds no forge write credential, and should not until it
  does. Commits reach an SSH host over the daemon's own SSH key and a worker as bundles over its
  connection; neither is anything a stage's commands can read.
- **Provider API keys** are injected per deployment and never enter a worktree.

### Backups

- **Nightly database backups.** The `backup` service (in both compose files) is `postgres:17` —
  the same image as `db`, so the dump and server versions cannot drift — and writes a
  `pg_dump -Fc` of `db` (never `db-test`, which is tmpfs by design) once a night at 03:00 in the
  service's `TZ` to `WILSON_BACKUP_DIR` (the development stack: a host directory outside the repo,
  default `../.wilson-backups` relative to `docker-compose.yml`; the server stack: `backups` under
  `WILSON_APPDATA`). Each dump is written to a temporary name and renamed on success, so an
  interrupted dump is never mistaken for a good one, and anything older than fourteen days is
  pruned after each successful dump. `wilson doctor`'s "database backed up" check reads the same
  directory and fails when the newest dump is stale or does not read as a dump. To restore:
  `pg_restore -d wilson <file>`.
- **Back up the secrets with the database.** The session signing key and the encryption key under
  `secrets` are generated on first boot. Losing the encryption key makes every enrolled
  authenticator unreadable, and every engine token saved in Wilson: a dump holds only their
  ciphertext. Save each token again to recover it.
- **The engine token.** The Settings page saves it in `wilson.settings`, encrypted under the same
  key, and it needs no restart to change. Resolved in order: that row, `CLAUDE_CODE_OAUTH_TOKEN` from
  the environment, then the login under the Claude config directory. It signs in engines on this
  machine only, and never travels to a host. A new token reaches stages and planning sessions
  started afterwards. A local stage can still read it from its environment, so this protects it at
  rest and nothing more.
- **Worker engine tokens.** Wilson holds any number of named tokens in `wilson.engine_tokens`, encrypted
  under the same key, and each worker host is assigned one, or none to use the worker's own
  (`wilson engine-token`, the Settings and Hosts pages). Each records its provider, its kind
  (`subscription` or `api_key`) and a priority, but only an Anthropic token can be assigned or pooled,
  since the engine is `claude`: a subscription's token reaches it as `CLAUDE_CODE_OAUTH_TOKEN` and an
  API key as `ANTHROPIC_API_KEY`. A token can also join
  the pool (`wilson engine-token update <name> --pool`): an engine with no token assigned, here or on
  a worker, takes the first pooled token with no usage limit in force, lowest priority first. Wilson
  reads the engine's rate limit events, keeps what each account hit in `wilson.engine_limits`, and
  holds a stage stopped by a limit through the interruption path: it is sent again at once on the
  next free account, resuming its session, or when the soonest limit resets. None of it is readable through the API or
  reachable by MCP, and the assignment is an operation of its own so that it stays out of agents'
  reach too. Each engine start reads the assignment again and sends the token in that one `spawn`
  or `run-claude` message, not in `welcome`, so a replaced token needs no reconnect and an idle worker
  holds none. Wilson is therefore the holder of these credentials. Anyone with a host's worker token
  can obtain the token assigned to it, and so can a stage on that host (`apps/worker/README.md`), so one
  token per trust level is what limits the damage. Removing a token here stops it being sent, and does
  not revoke it with Anthropic. Wilson and its workers must be the same protocol version, so update
  them together.

### Moving the board to the server

The development stack keeps the board in `wilson-db`'s anonymous volume. Move it with a dump, never
by copying or recreating that container: stop the daemon so no stage is running, `pg_dump -Fc` from
`wilson-db`, start the server stack's `db`, and `pg_restore` into it before starting `api`. Then
update every `wilson.projects` row's `codeRoot`, `worktreeRoot` and `runRoot` to the container's
paths, since they still name the development machine's.

## Build order

Steps 1–4 and the queue are built and merged; what follows them is not. Progress is
tracked on the board, not here — this list survives as the intended shape.

**Built:** the walking skeleton, board schema, runner core, human gates, the
implementing, testing and review stages with their verifiers, transitions written by
the runner, the pg-boss queue with stage chaining, and the daemon that drains it. A
card is enqueued once and runs to the `ready` gate unattended. The daemon can also
enqueue that first job itself: a poller, off by default behind `POLLER_ENABLED`
(`.env.example`), ticks on an interval (`POLLER_INTERVAL_MS`,
`apps/api/src/modules/jobs/job.runner.config.ts`) and enqueues at most one card per
tick — the same one `nextCard` would hand a human, run past the same
`whyNotDispatchable` refusal and `CardJobs.inFlight` claim check `wilson card start`
uses, never a second idea of "ready". It will not promote a card out of the parking
lot, move anything through a `manual` gate, or dispatch a card blocked on an unmerged
dependency — those stay exactly as manual as before. `wilson card start` still works,
poller on or off; turning `POLLER_ENABLED` off runs the daemon as the pure drainer it
always was, no code change required.

**What is next.** This was a numbered "in order" list and is no longer ordered — work
has been pulled from it by what unblocked next, not by position, and four of the seven
items were finished out of sequence. Cards cited list positions as their gate
(card 0027 did), which implied a schedule that does not exist. It is now a checklist:
what is done, what is not, and what each remaining one is actually waiting on.

**Done:**

- **Budget caps.** `maxCardInputTokens`, checked before a worktree is cut so an
  over-budget card never reaches a model. Input caps are cost-weighted: fresh input
  at 1, cache reads at 0.1, cache writes at 1.25 (`budgetedInputTokens`), mirroring API
  pricing. Stats show raw tokens, so a stage's figure there is not what its cap saw.
- **Gate stats.** `GET /api/stats/gates` and the Gates panel on the web stats page report kickbacks by
  reason, why attempts failed, questions, rule failures, loop stops, how often a person was pulled in and
  first-pass rate. A flag counts once however many events describe it. Older `stage.failed` events have no
  `failureClass`, so they are matched by text and labelled as matched. A `revise` is a pass in `/api/stats`,
  so the page takes those out of its pass rates.
- **Engine compaction.** A lane's optional `autoCompactWindow` sets the window the `cli`
  engine compacts against, at about that window minus 33k. Unset leaves it to the engine.
  Stage config refuses a window `maxContextWindowFraction` would stop first, from about
  315k at 0.9. Each compaction is a `stage.compacted` event.
- **Worktree GC.** `reclaimIfTerminal` on a terminal transition; `preserveUncommitted`
  keeps a failed attempt's work as a patch first.
- **Planning, and the interactive planning surface.** The `planning` stage, the
  server-side session (cards 0131–0133), and the app's conversation and draft panes
  (cards 0137, 0138). No `plan-review` stage was built and none is planned — approval
  into `backlog` is the gate instead.
- **ContractKit contract, the API, and the web board.**
- **Multi-project registry, port allocation, dry-run toggle.** The registry landed as
  cards 0148–0156 and 0162: `wilson.projects`, ambient project context, the
  `X-Wilson-Project` header, project-scoped app routes, and `GET /api/projects`. Port
  allocation followed on top of it — card 0165 built leasing as a mechanism with no
  consumer, card 0027 made ports its first resource type, and card 0167 closed the one
  gap that consumer found. It is off unless `DEV_SERVER_PORT_RANGE` is set. The
  dry-run toggle is card 0144. Filesystem reconciliation was once on this list and is
  not coming: with the board in Postgres there is no file to reconcile against.
- **Plugins: context providers.** Cards 0185–0189, the narrower of the two plugin seams:
  `wilson.card_context` and its repository, a `ContextProvider` interface with a URL
  provider that reuses card 0107's destination check rather than writing a second one,
  the `context.ck` contract and its SDK, the planning agent reading a card's snapshots
  as quoted source material on the turn they are attached, and attach-and-review on the
  card page. Retention (`context.retain: keep | ephemeral`) is card 0190 and parked by
  its own note: snapshots are kept, which is the default this document specifies, and no
  project yet needs the other setting.

**Not done:**

- **Plugins: card sources.** The other, larger seam — context providers above are done.
  A ticket source is a stateful bidirectional sync with identity mapping and webhooks,
  as against the stateless one-shot read that shipped, which is why this document treats
  them as two extension points rather than one. `cards.external` and `source_closed` are
  already columns on `wilson.cards`, put there for this.
- **Compose stack.** Card 0074's remaining half — mounting a `CLAUDE_CONFIG_DIR` at a
  volume — waits here. The setting itself does not (card 0141).

## Bootstrapping

The system builds itself starting from a walking skeleton, not from a finished
pipeline. The human is the fallback for every stage that does not exist yet, so the
only work on the critical path is work a human cannot stand in for.

### Do not saw off the branch you are sitting on

Self-hosting makes decision 8 ambiguous, and the ambiguity is dangerous. When the
project _is_ the runner, almost all of the runner's source is legitimately in scope
for cards — so "agents cannot modify the machinery" has to mean the **running
deployment**, not the source tree.

- The daemon runs from an installed build, never from the worktree it is editing.
- A card edits source. Rebuilding and redeploying is a deliberate human act between
  cards, never a side effect of one.
- The deployed version is pinned. Upgrade after a clean supervised pass, not on every
  merge.
- The CLI path stays working forever. It is the recovery tool when a card breaks the
  dispatcher, and the only way to run a stage when the daemon will not start.

A card that breaks the runner must not be able to prevent the next card from fixing
it.

**This rule is easy to state and easy to violate.** Node loads its modules once, so a
daemon started before a fix carries on running the code from before it. Card 0014
failed three times against a scope bug that had been fixed on disk half an hour
earlier — the same error, on the same files, from a build nobody could see, and the
failures were indistinguishable from the bug still being there. `wilson doctor` now
fails when the running daemon predates HEAD, because requiring a thing and noticing
when it is violated are different.

**Editing the runner while a card runs through it is its own hazard.** Card 0014's
branch ended up conflicting irreconcilably with main: the card was adding budget caps
to the same files the runner was being repaired in. The rebase check caught it, the
conflict was classified permanent, and the card was poisoned rather than looping —
which is the machinery working, and also a reason to keep cards away from files under
active repair.

### Step 0: the walking skeleton

Hand-run, no queue, no API, no UI. One project — this one.

- board repository over Postgres, with the card write and its event in one transaction
- scope matcher: allow globs, deny list, `request_scope`
- worktree manager: create, branch, destroy, reclaim
- agent runner: `ToolLoopAgent`, the six tools, `Output.object`, budget via `stopWhen`
- one stage — implementing — with its three-part exit condition
- transition writer and the Postgres event log
- johnny5: `card run <id> --stage implementing`, plus a `doctor` check

Then card zero is real work: use it to build the testing stage.

### What must be right the first time

These are constraints, not features. Each one is cheap now and expensive to retrofit,
because everything built afterward assumes it:

- **Scope enforcement in the write tool.** Retrofitted, safety becomes opt-in.
- **Structured output.** Parsing prose later is a tar pit.
- **Plan version pinning.** Immutability added afterward means touching every stage.
- **Board writes and their events share a transaction.** Retrofitted, every transition is
  a two-phase write with no way to reconcile a partial failure.
- **Sole-writer transitions.** Once writes are scattered, they never come back.
- **Seams, even with one implementation.** Stage dispatch takes a stage config object
  though only one stage exists; the board layer is a library that knows nothing about
  the CLI; the agent runner returns a `StageResult` regardless of mode. Writing the
  seam costs an hour. Retrofitting it is the rewrite.
- **Bash is an allowlist from day one.** Stage config names the commands a stage may
  run (`pnpm build`, `pnpm test`). This is _less_ work than a general bash tool, and
  it is the sandbox the design wants anyway.

### What to defer without guilt

Everything additive. Deferred at step 0, and now mostly built — kept because the
reasoning is what matters, not the checklist:

| Deferred                        | Human does instead              |
| ------------------------------- | ------------------------------- |
| planning and plan-review stages | writes the plan file by hand    |
| testing and review stages       | runs the tests, reads the diff  |
| queue and daemon                | runs the CLI                    |
| API and web app                 | reads the board through the CLI |
| notifications                   | is sitting right there          |
| multi-project, plugins, compose | one project, local node         |

One of those rows has since gone stale in a way worth naming, because the reasoning
is the point. Deferring the API and web app was cheap when the board was markdown:
the human read it in an editor and lost nothing. Moving the board into Postgres took
that fallback away — `wilson card show` and psql are what is left — so this deferral
became materially more expensive than it was when it was made, without anyone
deciding to make it so. A read-only board is no longer merely additive.

Hand-writing the first plans is not a compromise, it is the point. Decision 4 already
guarantees a hand-written plan is indistinguishable from a generated one downstream,
and writing several by hand is how you learn what a good plan for this system looks
like — which is the open question this brief ends on.

### Order after card zero

Sequenced by human toil removed per unit of work:

1. **testing stage** — stops you running the suite by hand.
2. **jobbroker dispatch** — stops you running the CLI. This is the step change: the
   moment you can walk away, dogfooding starts compounding.
3. **planning and plan-review stages** — deliberately third. Write plans by hand
   until you know what a good one looks like.
4. **API and the read-only web board** — stops you reading the board through psql.
5. Everything else, as cards.

## Non-goals

- Multi-user. Single operator: one human account, no invitations, no roles between people.
  The API does authenticate that operator and the API keys they mint (decision 10). What stays
  out of scope is distinguishing one person from another.
- Real-time agent-to-agent communication. If two cards need to talk mid-flight,
  they should have been one card.
- Replacing the plan conversation. Planning stays interactive.
- Hosting the projects. Repos are mounted from the host, not managed by us.
- A third-party plugin ecosystem. Plugins are in-process modules the operator
  writes, so there is no sandboxing, permission, or versioning story.

## Resolved during review

- **Board layer:** own the schema; Backlog.md dropped. See decision 2.
- **Source of truth:** Postgres for the board, git for code. See decision 1.
- **Agent invocation:** AI SDK `ToolLoopAgent`, not `HarnessAgent`, with a `cli`
  adapter as an escape hatch. See the architecture section.
- **How a stage prompt receives the plan:** an absolute file path outside the card's
  worktree, materialized at its approved version. Prompt injection burns context and does not
  survive a retry; stdin does not survive a re-dispatch.
- **Where per-card event state lives:** append-only in Postgres, in the same transaction
  as the transition it describes.
- **Board schema:** a card is a row; `card_versions` carries its history. See Board
  schema.
- **Files in scope:** globs plus a deny list, enforced in the write tool, with
  `request_scope` as an auditable escape valve. See Scope enforcement.
- **Out-of-band edits:** there is no out-of-band path; the operator edits through the CLI
  or the web app. See The operator's escape hatch.
- **Reaching a human:** a webhook and Android push, six moments, sent inline. See
  Notification.
- **Adversarial plan review:** its own stage, no worktree, not a gate inside
  planning. See Stage model.
- **Granularity and throughput:** interface-first decomposition keeps chains one
  deep; monolithic refactors get no parallelism and that is accepted. See Card
  granularity.
- **Plugins:** three narrow seams — card source, context provider, notification
  channel — as in-process `ServerKitModule` registrations, not an ecosystem. See
  Plugins.
- **Plan-review verdict schema:** four fields, section enum, blocker-implies-revise,
  no revised-plan field. See Stage model.
- **Image toolchains:** declared per project and doctor-checked at boot; exotic
  toolchains mean a Dockerfile edit. See Deployment.
- **Optimistic UI:** no. SSE plus query invalidation; drag feedback is animation.
  See Architecture.
- **Externally closed tickets:** drop if idle, finish the running stage then
  `needs-human`, never auto-merge. See Plugins.
- **API authentication:** one operator account plus scoped API keys, no localhost bypass,
  deadair's design minus multi-tenancy. See decision 10 and Authentication.
- **Context retention:** stored against the card, trimmed, with an `ephemeral` TTL escape
  for projects that cannot retain third-party text. See Plugins.

## Open questions to resolve in planning

Nothing blocking remains. What is left is best answered by building step 1 and
looking at the result:

- How large is a realistic plan file in practice, and does the strongest model
  produce one good enough that `scope_violation: kickback` is reachable, or does
  `widen` stay on indefinitely?
- Does `plan-review` earn its cost, or does human approval catch everything it
  catches? Worth measuring once a few cards have run rather than assuming. Measuring the
  reviewer (above) is the method to start from, though it scores only the review stage.
