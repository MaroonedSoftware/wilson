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
   anchors and budget accounting are rows. The code repo holds code and nothing else.
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
7. **Stages are config, not code.** Adding a stage, re-routing models, or changing
   a provider is a config edit.
8. **Agents cannot modify the machinery.** Stage config, stage prompts, and
   everything under `.runner/` are human-write-only, enforced in the write tool.
   This system is meant to build itself under review; an agent that can rewrite its
   own exit condition passes every time.
9. **One project is one board.** Everything below is per project: board rows, stage
   config, worktree root, port range, git credentials. A project is a row, not a
   directory — which is what makes twenty projects twenty rows rather than twenty git
   clones the daemon must hold open and keep current.

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
`CommandAllowlist` are not the tools themselves. They are put back through
`canUseTool`, which every Write, Edit and Bash passes before it runs.

**`allowedTools` must not be set.** Listing a tool there marks it _pre-approved_ and
the engine never consults `canUseTool` for it — so naming Write and Bash as allowed,
which reads like granting exactly the intended permissions, silently disables every
check meant to constrain them. Measured, not reasoned about: with Write allowed, a
probe wrote a file outside the declared scope and the guard was never called once.
Permission comes solely from the callback, whose final branch denies any tool it does
not recognise.

The `report_result` tool is supplied to this adapter as an in-process MCP server
carrying the stage's own result schema. Without it a stage can only return prose,
which the review verifier rightly refuses, and the runner cannot tell an adapter
defect from bad work — it kicks the card back to implementing for something no amount
of re-implementing can fix.

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
| planning | agent | readonly | plan file written and parseable | plan-review |
| plan-review | agent | none | verdict schema valid | plan-approval |
| plan-approval | manual | none | human approval | implementing |
| implementing | agent | rw | build passes, diff non-empty, diff within scope | testing |
| testing | agent | rw | suite green, test count non-decreasing, no new skips, new tests fail against the pre-change tree | review |
| review | agent | readonly | findings schema valid, every finding cites a file:line in the card's diff, severity in enum | ready |
| ready | manual | none | human approval | merge, then `merged` |

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

Terminal states: `merged` (done), `needs-human` (retries exhausted; the plan is
probably wrong, not the code), `poisoned` (an infrastructure failure, not a quality
one), `dropped` (a card source closed its ticket while nothing was running).

A card reaches `poisoned` when a stage throws an error that retrying cannot fix:
billing, credentials, a malformed request, a rebase conflict. Such a failure must not
be a kickback. A card's retry budget is for work that came back wrong, and spending it
on an exhausted balance both wastes the budget and misreports the cause — this project
watched a card burn three retry cycles against "credit balance is too low", each one
cutting a worktree and installing dependencies before failing at the first model call.
The job returns normally after poisoning so the queue does not retry it either.

Classification is by message text, because neither the SDK nor the provider surfaces a
stable machine-readable class. It is deliberately conservative: a miss costs a few
retries, a false positive strands a card that would have recovered.

Three modes for a stage, borrowed from AO (github.com/launchapp-dev/ao):
`agent` (spawns a model), `command` (runs a shell command), `manual` (human gate).
Human gates are a first-class stage type, not a special case in the runner.

Review failure moves the card backward with findings appended to the plan and a
retry counter incremented.

### Parking lot

Not a stage — a column the dispatch query excludes. Cards there are stubs: a title
and a note, no plan, no branch, no worktree, never claimed by a job. The only
transition out is a human promoting one into planning, which is also where it first
acquires a plan file. It exists so a thought can be captured mid-review without
becoming work.

### Per-stage model routing

Model and provider are properties of the stage, not a per-task choice. Defaults:

- planning and adversarial plan review: the strongest available model
- implementing: strong model, full tool access
- testing: mid-tier
- code review: strong model, read-only tools

Each project's stage config may override provider and model per stage — Anthropic,
OpenAI, or xAI — since they are one `ToolLoopAgent` model argument apart. Provider
credentials are per-deployment, not per-project.

The adversarial reviewer reads the plan cold, with no access to the planning
conversation, and emits `{verdict, findings[]}`.

### Whose work a stage is judged on

Two different questions, and conflating them strands cards.

`changedPaths` measures from the fork point, so it describes **the card**: everything
it has changed across every stage. That is the right basis for a review's finding
provenance, which is a claim about the card's diff.

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
  to the agent as anchored instructions. The agent revises the plan and marks each
  addressed. Per decision 4, only the resulting plan text binds downstream stages —
  the thread is not carried into implementation.
- **Approval is explicit and versioned.** Approving writes a card version and pins the
  card to it. That version, not the live document, is what every downstream stage reads.

## Board schema

A card is a row. Column membership is a column, so a transition is one `UPDATE` inside
the same transaction that writes its event — the property the old two-store split could
not provide.

```
projects        id, name, code_root, worktree_root, port_range, ...
runner.cards    (project, id) PK, title, stage, branch, body, retries,
                external, source_closed, position, pinned_version_id, created_at
runner.card_deps       (project, card_id, depends_on_id) — FK both ways
runner.card_versions   id, project, card_id, frontmatter, body, message, created_at
runner.card_events     append-only; every claim, denial, grant and transition
```

`runner.cards` is current state — what `card list` and dispatch read. `runner.card_versions`
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

**Stage config is still a file**, at `config/stages.yaml` under the project's board
directory. It is machinery, not board state: human-write-only (decision 8), reviewed like
code, and deliberately not reachable through any API an agent could call.

## Scope enforcement

`Files in scope` holds globs, not paths — `src/runner/**`, `test/runner/**` — so a
plan does not have to predict every file it will create. The write tool allows a
path when it matches a scope glob and no deny glob. The deny list always contains
`.runner/**` and stage config (decisions 6 and 8) — board paths no longer exist in a
worktree to deny. Each project's
config adds an `always_allowed` list for generated and machine-owned files that no
plan should have to mention — `pnpm-lock.yaml`, `src/generated/**`.

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
`by: human` and cancelling any in-flight job for that card — the same semantics the
reconciler gave state-field edits, now explicit rather than inferred from a file change.

Frontmatter is deliberately not editable through `card edit`: stage, branch and retries are
runner state (decision 5), and `card move` is the recorded way to override one.

## Notification

ServerKit `comms` with a `ChannelRouter`; the Slack and Discord packages each ship a
`./comms` adapter, so the channel is configuration. Per project:
`notify: { channel: slack, target: "#wilson" }`.

Notifications are dispatched as jobbroker jobs, never inline, so a Slack outage
cannot fail a transition.

Four triggers only — anything more and the operator learns to ignore them:

- a card enters a `manual` stage and is waiting on a human
- a card reaches `needs-human`
- a card dead-letters to `poisoned`
- a dry-run pass completes end to end

Each message deep-links to the card in the web app.

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

Already covered by ServerKit `comms`. A `ChannelRouter` with the Slack or Discord
`./comms` adapter makes the channel a config value, so this seam needs no new
mechanism — see Notification.

### Imported content is untrusted

A Slack thread or a Linear ticket is text written by someone who is not operating
this system, and it flows into a planning agent whose output an implementing agent
executes. Treat it as data, always:

- Context snapshots are delimited as quoted material in the prompt, never
  concatenated as instructions.
- A plan is still gated by `plan-review` and human approval before anything runs.
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

Single `docker compose` stack: API + daemon in one image, the web app served
statically from it, and Postgres.

- **Code repos are mounted volumes.** Projects live on the host; worktrees are created
  inside the mount so the host can inspect them and open them in an editor. The board is
  not a mount — it is in Postgres, which is already in the stack.
- **Project builds run in the daemon container.** Build and test commands execute
  directly, so the image carries each project's toolchain (Node, pnpm, and whatever
  else a registered project needs). This is the constraint of dropping Docker from
  the requirements: a project whose test suite needs containers cannot be driven by
  this runner yet. Revisit with a rootless Docker-in-Docker sidecar if that becomes
  binding — never by mounting the host Docker socket, which would hand
  model-authored code root on the host and defeat every other boundary here.
- **Toolchains are declared, not discovered.** The base image carries what this
  project needs (Node 22+, pnpm, git), since the system builds itself first. Each
  registered project declares its required runtimes and a `setup` command run once at
  worktree creation. A johnny5 `doctor` check verifies every registered project's
  declared toolchain is present at boot, so an unsupported project fails loudly at
  registration rather than mysteriously at stage four of a card. Onboarding an exotic
  toolchain means rebuilding the image — a Dockerfile edit, not an architecture
  change. Reach for a runtime manager like mise in the image only if that becomes a
  regular chore.
- **A published port range** maps the per-worktree dev server ports out to the host.
- **Git credentials belong to the runner, not to agents.** A mounted deploy key,
  reachable only through a credential helper the runner invokes when it commits
  board state or pushes a card branch. The bash tool never sees it.
- **Provider API keys** are injected per deployment and never enter a worktree.

## Build order

Steps 1–4 and the queue are built and merged; what follows them is not. Progress is
tracked on the board, not here — this list survives as the intended shape.

**Built:** the walking skeleton, board schema, runner core, human gates, the
implementing, testing and review stages with their verifiers, transitions written by
the runner, the pg-boss queue with stage chaining, and the daemon that drains it. A
card is enqueued once and runs to the `ready` gate unattended.

**Next, in order:**

1. **Budget caps.** The pipeline self-chains unattended and nothing bounds input
   tokens or wall-clock. `maxSteps` bounds the loop and `maxOutputTokens` bounds a
   single response; one stage consumed 6.3M input tokens while its output cap held it
   to 50k. Retry limits bound the loop count, not the cost. The `cli` adapter needs
   this too, and differently: the engine has native `maxTurns`, `maxBudgetUsd` and
   `abortController`, so a cap built only as an AI SDK `stopWhen` bounds the adapter
   nobody is using.
2. **Worktree GC.** Nothing reclaims a card's worktree on completion, and the baseline
   check cuts a second one per testing run. This reached 3.5 GB across 15 worktrees
   before anyone looked.
3. **The poller**, so cards start themselves rather than needing `card start`. It needs
   to know what is already in flight before it can enqueue safely. Deliberately after
   the safety rails: autonomy last.
4. Multi-project registry, port allocation, dry-run toggle. Filesystem reconciliation
   was on this list and is not coming: with the board in Postgres there is no file to
   reconcile against.
5. Planning and `plan-review` stages; the interactive planning surface.
6. ContractKit contract, the API, and the web board.
7. Plugins: card sources and context providers.
8. Compose stack.

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

- Multi-user. Single operator. No per-user permissions on the API.
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
- **Reaching a human:** ServerKit `comms`, four triggers, dispatched as jobs. See
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
- **Context retention:** stored against the card, trimmed, with an `ephemeral` TTL escape
  for projects that cannot retain third-party text. See Plugins.

## Open questions to resolve in planning

Nothing blocking remains. What is left is best answered by building step 1 and
looking at the result:

- How large is a realistic plan file in practice, and does the strongest model
  produce one good enough that `scope_violation: kickback` is reachable, or does
  `widen` stay on indefinitely?
- Does `plan-review` earn its cost, or does human approval catch everything it
  catches? Worth measuring once a few cards have run rather than assuming.
