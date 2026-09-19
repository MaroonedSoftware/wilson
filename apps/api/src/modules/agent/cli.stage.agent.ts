import { readFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { createSdkMcpServer, query, tool, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { CLAUDE_CONFIG_DIR } from '#modules/settings/claude.config.dir.setting.js';
import { contextBudgetExceeded, engineSilent, overBudget, stepsExceeded, wallClockExceeded } from './budget.js';
import { REPORT_RESULT_PATH, SCRATCH_PREFIX } from './scope.guard.js';
import type { AgentRunInput, AgentRunOutput } from './stage.agent.js';
import { StageAgent } from './stage.agent.js';
import { deleteFile } from './tools/delete.tool.js';
import { requestScope } from './tools/scope.tool.js';
import type { ToolContext } from './tools/index.js';

/**
 * The environment the engine runs with, minus any provider API key.
 *
 * AppConfig's dotenv source loads `.env` into `process.env`, so `ANTHROPIC_API_KEY` is visible to
 * the SDK — and the SDK prefers a key over the operator's own credentials when it sees one. That
 * silently routes this adapter back through per-token API billing, which is the exact thing it
 * exists to avoid: the first run of it failed on "Credit balance is too low" while a perfectly good
 * subscription sat unused.
 *
 * `configDir`, when given, is set as `CLAUDE_CONFIG_DIR` — the directory the engine reads its own
 * Claude Code credentials from (card 0141: an operator's choice, via the `claude-config-dir`
 * setting, rather than whatever the daemon user's own `~/.claude` happens to hold). Left `undefined`
 * — the setting unset — the environment is exactly what it always was, with no `CLAUDE_CONFIG_DIR`
 * key at all: a fresh install behaves identically to before this card. Resolving that setting is
 * async and needs the container, which this function deliberately stays free of (this card's
 * Constraints: "`subscriptionEnv()` stays synchronous and dependency-free") — both callers resolve
 * it themselves and pass the result in, the same way they already resolve everything else this
 * function does not know about on its own.
 */
export const subscriptionEnv = (configDir?: string): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Card 0194. `AppConfigSourceDotenv` mutates `process.env` — the same load that puts
    // `ANTHROPIC_API_KEY` there, which is why the line above exists — so the daemon holds
    // `DATABASE_URL` and the copy above hands it to the engine, and to every Bash command the
    // engine runs. That is a credentialed connection to the database holding `runner.cards`,
    // `runner.card_versions` and `runner.stage_configs`: the board itself. Nothing exploited it
    // because no allowlisted command takes a connection string, but that is the command allowlist
    // holding the line — the guardrail decision 8's own note distinguishes from a boundary — and
    // decision 6's "unreachable from a worktree by construction" is true of the disk (`.env` is
    // gitignored, so no worktree has one) and was not true of this environment.
    //
    // A prefix rather than the five names: `DATABASE_URL` and the `DATABASE_HOST`/`PORT`/`USER`/
    // `PASSWORD`/`NAME` set are the same secret in two shapes, and a sixth added to `.env` later
    // should not need remembering here. `TEST_DATABASE_*` is deliberately untouched: it names the
    // disposable tmpfs database the suite already writes to, and stripping it would change what
    // `pnpm test` does inside a stage.
    for (const key of Object.keys(env)) {
        if (key.startsWith('DATABASE_')) delete env[key];
    }
    if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir;
    return env;
};

/**
 * The in-process MCP server carrying this adapter's report and scope-request tools, and the names
 * the engine exposes them under. MCP tools are addressed as `mcp__<server>__<tool>`, which is what
 * the model must call and what `canUseTool` sees.
 */
const REPORT_SERVER = 'wilson';
const REPORT_TOOL = 'report_result';
const REQUEST_SCOPE_TOOL = 'request_scope';
const DELETE_TOOL = 'delete';
const qualifiedReportTool = (): string => `mcp__${REPORT_SERVER}__${REPORT_TOOL}`;
const qualifiedRequestScopeTool = (): string => `mcp__${REPORT_SERVER}__${REQUEST_SCOPE_TOOL}`;
// Exported so a test can assert the prompt names this tool by a value derived from the same
// constant the MCP server below registers it under, rather than a literal the two could drift
// from independently (card 0097 — that drift, a bare `delete` typed into board config instead of
// this, is exactly the bug this file now guards against).
export const qualifiedDeleteTool = (): string => `mcp__${REPORT_SERVER}__${DELETE_TOOL}`;

/** The engine's own tools, named as it names them. */
const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = ['Write', 'Edit'];
const EXEC_TOOLS = ['Bash'];

/**
 * Runs a stage through the Claude Code engine instead of a provider API.
 *
 * Authentication comes from the operator's own Claude Code credentials, so this path keeps working
 * when the API balance is empty — which is exactly why it exists.
 *
 * The engine brings its own tool loop and its own tools, so `ScopeGuard` and `CommandAllowlist` are
 * not in the path the way they are for the `api` adapter. `canUseTool` is where they are put back:
 * every Write, Edit and Bash the engine proposes is checked against the same guards before it runs,
 * and a denial is returned to the model as a message rather than thrown.
 *
 * **`allowedTools` is deliberately not set.** Listing a tool there marks it *pre-approved*, and the
 * engine then never consults `canUseTool` for it — so naming Write and Bash as allowed, which reads
 * like granting exactly the intended permissions, silently disables every check meant to constrain
 * them. Measured, not assumed: with Write allowed, a probe wrote a file outside the declared scope
 * and the guard was never called once. Permission comes solely from the callback, whose final
 * branch denies any tool it does not recognise.
 *
 * **`settingSources` is deliberately set to `[]`, and `strictMcpConfig` to `true`.** Left unset,
 * `query()` does not mean "no filesystem settings" — the installed SDK's own type declaration says
 * so plainly: "When omitted, all sources are loaded (matches CLI defaults)." A probe on 2026-08-25
 * confirmed it loads for real: the `init` message's tool list carried every built-in the host CLI
 * ships (`Task`, `Workflow`, `Artifact`, `WebFetch`, …) plus every MCP server configured in the
 * *operator's* `~/.claude` — on that machine, sixteen `mcp__codebase-memory-mcp__*` tools, none of
 * which this stage can use. `createToolGuard`'s default-deny means none of it was ever reachable,
 * but a runner whose visible tool surface depends on whose laptop the daemon happens to run on is
 * not reproducible, and every one of those definitions is resent as input tokens on every turn.
 * `settingSources: []` is the CLI's own name for this — "SDK isolation mode" — and stops the
 * user/project/local `settings.json` files from loading at all. That schema has no `mcpServers` key
 * of its own, though — an operator's `mcp__codebase-memory-mcp__*` server (the one the probe found)
 * is registered by `claude mcp add --scope user` into `~/.claude.json` instead, a different file
 * `settingSources` does not reach. `strictMcpConfig: true` is what closes that: it restricts the
 * engine to only the MCP servers passed via this call's own `mcpServers` option — the `wilson` server
 * below — ignoring `~/.claude.json`, a project's `.mcp.json`, plugin-declared servers and subagent
 * frontmatter MCP alike. Confirmed against a live engine, not assumed from either option's docs:
 * with both set, a decoy server named in a fixture `~/.claude.json` does not appear on the `init`
 * message at all; with them unset, its tool appears the same as `codebase-memory-mcp`'s did. Together
 * the two make the tool surface a function of this adapter's own code, not of the machine it happens
 * to run on. `wilson card plan` is a different call site: it spawns `claude` directly for an
 * interactive planning session, where the operator sitting at the terminal arguably should see their
 * own setup, and it is not changed here.
 *
 * **`stage.instructions` (board config) must never name a tool, bare or qualified.** Config
 * cannot know which adapter will run a given stage — `adapter` is a field on the very same stage
 * config, and can change — and `api` and `cli` name a deletion capability differently (this one
 * bare, `cli`'s MCP-qualified). Whichever adapter is chosen builds its own tool-naming lines from
 * its own constants and appends them after `stage.instructions` in the prompt below, so a name
 * typed into config would win a disagreement it has no business having — exactly the bug card
 * 0097 fixed. Guidance belongs in config; the tool's actual name belongs only here.
 */
@Injectable()
export class CliStageAgent extends StageAgent {
    // `settings` is optional so a test that constructs this class directly — bypassing DI, the way
    // every existing test in `tests/modules/agent/cli.*.test.ts` already does — keeps working
    // unchanged: no store means no row to read, which resolves `configDir` below to `undefined`,
    // the same "unset means unchanged" behaviour this card's Constraints require anyway. Production
    // wiring (`agent.module.ts`'s `useClass(CliStageAgent)`) always supplies the real one.
    constructor(
        private readonly logger: Logger,
        private readonly settings?: SettingsStore,
    ) {
        super();
    }

    async run({ stage, context, planPath, learningsPath, title, resultSchema, baseSha }: AgentRunInput): Promise<AgentRunOutput> {
        // Resolved once, up front — a setting read while a card is in flight must not change what
        // this run uses partway through (this card's Constraints: "a change applies to stages
        // started afterwards"), and `subscriptionEnv` below stays synchronous, so the read has to
        // happen out here rather than inline where it is used.
        const configDir = await this.settings?.get(CLAUDE_CONFIG_DIR);

        // The engine has no equivalent of the api adapter's report tool, so one is supplied as an
        // in-process MCP server. It takes only a path, not this stage's own result schema — see the
        // tool's own definition below for why crossing that transport as tool arguments is exactly
        // what this adapter cannot afford — and validates what it reads against `resultSchema`
        // itself. Without it a stage can only hand back prose, which the review verifier rightly
        // refuses — card 0014 failed its review on a missing `verdict` and was kicked back to
        // implementing for a defect no amount of re-implementing could fix.
        let reported: unknown;
        // A `report_result` tool_use block appearing in the stream is the model having called the
        // tool, independent of whether the callback above ever ran to set `reported` — see
        // `droppedField` below, near the returns, for why that gap matters and what it is charged as.
        let reportToolSeen = false;
        // Card 0126: whether *any* tool_use block — this MCP server's or one of the engine's own
        // built-ins — has appeared anywhere in the run, not just the report tool. This is the
        // detail `reportToolSeen` alone cannot give: a run that wrote files and ran the build but
        // forgot the final report call, and a run that never called a single tool and simply
        // stopped, both leave `reported` undefined with the same `engineStopReason` text — only
        // this flag tells them apart. Sticky for the same reason `reportToolSeen` is: a later
        // message carrying only text must not erase that a tool ran earlier in this run.
        let anyToolSeen = false;
        // The api adapter's buildTools only exposes request_scope when worktreeMode === 'rw' — a
        // readonly or none stage can never write, so granting it the tool would let it log
        // scope.requested/granted events (or trip ScopeKickbackError under the kickback policy) for a
        // widening it could never use. This adapter honours the same condition rather than exposing
        // the tool unconditionally.
        const canWrite = stage.worktree === 'rw';
        // Whether this run's exit condition compares test counts against a baseline (see
        // `TestingVerifier.checkCounts`) — `testReportPath` is what that check reads, so its
        // presence is the same signal the verifier itself keys off. Used below to decide whether
        // the delete-tool guidance carries the "don't leave an it.skip behind" warning: that
        // consequence is only real where such a check actually runs.
        const checksTestCounts = stage.testReportPath !== undefined;
        const reportServer = createSdkMcpServer({
            name: REPORT_SERVER,
            tools: [
                tool(
                    REPORT_TOOL,
                    `Report the work you have completed and end the stage. Call this exactly once, only after you have made every change the plan asks for and the build passes. Write the finished result to ${REPORT_RESULT_PATH} — that file, and only that file, is how the result is delivered — then call this with its path, or with no path since that is the default.`,
                    z.object({
                        path: z.string().optional().describe(`Worktree-relative path of the finished result file. Defaults to ${REPORT_RESULT_PATH}.`),
                    }).shape,
                    async ({ path }: { path?: string }) => {
                        const target = path ?? REPORT_RESULT_PATH;
                        const decision = await context.scope.checkRead(target);
                        if (!decision.allowed) {
                            const message = `error: ${decision.reason}`;
                            this.logger.warn(`report_result: ${message}`);
                            return { content: [{ type: 'text' as const, text: message }] };
                        }

                        let text: string;
                        try {
                            text = await readFile(join(context.worktreeRoot, decision.path), 'utf8');
                        } catch (err) {
                            const message = `error: could not read ${decision.path}: ${(err as Error).message}`;
                            this.logger.warn(`report_result: ${message}`);
                            return { content: [{ type: 'text' as const, text: message }] };
                        }

                        const outcome = parseReportedResult(text, resultSchema as z.ZodTypeAny);
                        if (!outcome.ok) {
                            const message = `error: ${decision.path} ${outcome.reason}`;
                            this.logger.warn(`report_result: ${message}`);
                            return { content: [{ type: 'text' as const, text: message }] };
                        }

                        reported = outcome.value;
                        return { content: [{ type: 'text' as const, text: 'reported' }] };
                    },
                ),
                // The engine has no equivalent of the api adapter's request_scope tool either, so it
                // is supplied the same way — carried on this stage's own MCP server rather than
                // duplicated, so a stage that genuinely needs a file its plan omitted has the same
                // escape hatch here as on the api adapter (card 0004). `requestScope` is shared with
                // `scopeTool` so the two adapters cannot drift in what a grant means. Only present for
                // an `rw` stage, matching the api adapter's `buildTools`.
                ...(canWrite
                    ? [
                          tool(
                              REQUEST_SCOPE_TOOL,
                              'Request permission to write a file outside the plan’s files in scope. Explain why the plan did not anticipate it. Use sparingly.',
                              z.object({
                                  path: z.string().describe('Path relative to the worktree root.'),
                                  reason: z.string().describe('Why this file is genuinely part of this card.'),
                              }).shape,
                              async ({ path, reason }: { path: string; reason: string }) => {
                                  const message = await requestScope(context, path, reason);
                                  return { content: [{ type: 'text' as const, text: message }] };
                              },
                          ),
                          // The engine's own tool set has no delete: only Write and Edit. Supplied
                          // the same way as `request_scope` — carried on this stage's own MCP server,
                          // sharing `deleteFile` with the api adapter's `delete` tool (delete.tool.ts)
                          // so the two adapters cannot drift in what a deletion means. Only present
                          // for an `rw` stage, matching `write`/`edit`/`request_scope` above.
                          tool(
                              DELETE_TOOL,
                              'Delete one file in the worktree. Refuses a directory; use it once per file, never recursively.',
                              z.object({
                                  path: z.string().describe('Path relative to the worktree root.'),
                              }).shape,
                              async ({ path }: { path: string }) => {
                                  const message = await deleteFile(context, path);
                                  return { content: [{ type: 'text' as const, text: message }] };
                              },
                          ),
                      ]
                    : []),
            ],
            alwaysLoad: true,
        });

        // The engine has no direct "abort after this signal" option, so the timeout is wired through
        // an AbortController it does accept. A plain timer rather than `AbortSignal.timeout` because
        // this one has to be cancellable: a stage that finishes in ten seconds should not leave a
        // thirty-minute timer holding its controller alive. Unref'd so it never keeps the process up.
        // Refused calls do not spend the budget. A denial produces no work, and charging it the same
        // as progress is what turns friction into failure: 62% of this board's 518 denials were the
        // agent reaching for a shell that does not exist, and card 0032's first attempt died on its
        // step limit with a dozen steps spent that way. The ceiling grows by one per refusal, so a
        // run keeps its full allowance of productive steps.
        let denied = 0;
        let turns = 0;

        // The engine's own stderr, captured independent of how the run ends. The SDK keeps its own
        // tail for the message it builds once a nonzero exit or signal reaches it, but only that
        // far; capturing it directly here means it survives even when the process dies before the
        // SDK produces that message, and it reaches the event log rather than being lost with it.
        let stderrTail = '';
        const STDERR_TAIL_CHARS = 4000;

        const abortController = new AbortController();

        // Racing the read rather than signalling into it, because signalling does not work. Card
        // 0052's engine exited mid-run; `abortController.abort()` fired at the wall clock and the
        // stream never noticed — no `AbortError`, no return, nothing in the log. An iterator parked
        // on a dead pipe cannot be asked to wake up, so the only reliable move is to stop waiting
        // for it. `abort()` still fires, for the engine's benefit when there is an engine left to
        // hear it, but nothing depends on it any more.
        let stoppedBecause: 'wall-clock' | 'silent' | 'steps' | 'context' | undefined;
        // Set alongside `stoppedBecause === 'context'`, naming the cap and the usage the engine
        // reported at the moment it crossed — the one piece of information the generic
        // `stoppedBecause` tag cannot carry on its own, same reason `overBudget`'s message names
        // figures rather than just "budget exceeded".
        let contextFailure: string | undefined;
        let stop!: () => void;
        const stopped = new Promise<typeof STOPPED>(resolve => {
            stop = () => resolve(STOPPED);
        });

        const wallClock = setTimeout(() => {
            stoppedBecause ??= 'wall-clock';
            abortController.abort();
            stop();
        }, stage.maxWallClockMs);
        wallClock.unref();

        // Reset on every sign of life. Two of them: a message off the stream, and a tool call
        // starting — the engine goes quiet for the whole of a tool call, so without the second the
        // window would have to cover the tool *plus* the model turnaround that follows it.
        // Nothing to arm when the idle window is not shorter than the wall clock — the resolved
        // default clamps to `maxWallClockMs` for a stage with a tight time budget, and a guard that
        // can only fire at the same instant as the wall clock adds no detection, just a tie to
        // break and a worse attribution when it wins one.
        const idleGuards = stage.maxIdleMs < stage.maxWallClockMs;
        let idle: NodeJS.Timeout | undefined;

        // Read on the same beat the idle guard uses, rather than plumbing a separate hook: a
        // message off the stream and a tool call starting are already the only signs of life this
        // adapter watches for, and a request about to overflow the window is exactly as detectable
        // at either of those points as an idle engine is. `getContextUsage()` is a control
        // round-trip, so this fires it without awaiting from `beat()` itself — a stage moving
        // through many tool calls before the model's next turn must not stack up overlapping
        // requests on top of one another while the first is still in flight, hence `contextChecking`.
        let contextChecking = false;
        const checkContext = (): void => {
            if (contextChecking || stoppedBecause) return;
            contextChecking = true;
            // Called through a resolved promise rather than invoked directly: that turns a call the
            // running engine itself rejects into the same `.catch()` path below as a stream that
            // throws synchronously because it does not carry this method at all — a signal `beat()`
            // must survive either way, since it is invoked from inside the tool guard's callback.
            Promise.resolve()
                .then(() => stream.getContextUsage())
                .then(({ percentage }) => {
                    const failure = contextBudgetExceeded(stage.maxContextWindowFraction, percentage);
                    if (failure && !stoppedBecause) {
                        stoppedBecause = 'context';
                        contextFailure = failure;
                        abortController.abort();
                        stop();
                    }
                })
                .catch(() => {
                    // The engine may already be tearing down by the time this resolves — an abort or
                    // a dead stream races this exact call. Nothing to act on either way: a run that
                    // is already stopping does not need a second reason, and one that is not stopping
                    // just missed a beat and gets checked again on the next one.
                })
                .finally(() => {
                    contextChecking = false;
                });
        };

        const beat = (): void => {
            checkContext();
            if (!idleGuards) return;
            clearTimeout(idle);
            idle = setTimeout(() => {
                stoppedBecause ??= 'silent';
                abortController.abort();
                stop();
            }, stage.maxIdleMs);
            idle.unref();
        };

        const stream = query({
            prompt: [
                `Card: ${title}`,
                '',
                `Your plan is at ${planPath}. Read it before anything else. Its "Files in scope" is what`,
                `you may change and its "Out of scope" is binding even where you could make the change.`,
                '',
                ...(learningsPath
                    ? [
                          `Before you start, also read the project's learnings at ${learningsPath}. They are`,
                          `human-approved guidance for this project — follow them like the plan, not material to weigh.`,
                          '',
                      ]
                    : []),
                `You are in a git worktree at ${context.worktreeRoot}.`,
                '',
                `\`git diff ${baseSha}\` is the card's whole diff across every stage — this is what the`,
                `verifier measures and what a finding must cite.`,
                '',
                // `stage.instructions` comes from board config, which must not name a tool — see
                // the class doc comment above for why (card 0097). The lines below are this
                // adapter's own, appended after it, naming this engine's tools the only way it can
                // be sure they are named right: interpolated from the constants the MCP server
                // above actually registers them under.
                stage.instructions,
                '',
                ...(canWrite
                    ? [
                          `If the plan's "Files in scope" does not cover a file the work genuinely needs, call`,
                          `${qualifiedRequestScopeTool()} with the path and why, rather than working around the gap.`,
                          '',
                          `To remove a file the work no longer needs, call ${qualifiedDeleteTool()} with its path —`,
                          `it is scope-checked the same way a write is, and refuses a directory.`,
                          '',
                          ...(checksTestCounts
                              ? [
                                    `A test that no longer belongs gets deleted, not emptied and left as an 'it.skip':`,
                                    `this stage's exit condition compares the skipped-test count against the baseline,`,
                                    `and a new skip reads as a regression and fails the stage.`,
                                    '',
                                ]
                              : []),
                      ]
                    : []),
                `Write your finished result as JSON to ${REPORT_RESULT_PATH} in the worktree — that file, and`,
                `only that file, is how the result is delivered. It must satisfy this schema:`,
                JSON.stringify(z.toJSONSchema(resultSchema as z.ZodTypeAny)),
                '',
                `Anything you need to generate and inspect but that should not ship — a report to read,`,
                `a probe script's output, whatever an acceptance criterion needs produced and checked —`,
                `goes under ${SCRATCH_PREFIX} in the worktree. That path is writable in every stage,`,
                `including this one if it is read-only, and everything under it is wiped once the run`,
                `ends, so nothing written there is ever delivered, committed, or reviewed.`,
                '',
                `When the work is done and the build passes, call ${qualifiedReportTool()}; it defaults to`,
                'that path, so no argument is needed unless you wrote the result somewhere else.',
                'Work first, report last: that call ends the stage, and a result describing work you did',
                'not do fails it, because the runner checks the diff and not your summary.',
            ].join('\n'),
            options: {
                cwd: context.worktreeRoot,
                // 'default' so canUseTool is consulted rather than bypassed. Never
                // 'bypassPermissions': that is precisely the guard this adapter has to re-add.
                permissionMode: 'default',
                // Together these pin the tool surface to this adapter's own code — see the class
                // doc comment above for why each is needed and what it stops. Neither is a denial;
                // the guard's default-deny stays exactly as it is, unmoved.
                settingSources: [],
                strictMcpConfig: true,
                canUseTool: createToolGuard(
                    context,
                    stage.worktree,
                    () => {
                        denied += 1;
                    },
                    beat,
                ),
                env: subscriptionEnv(configDir),
                // Captured independent of how the read loop ends — the only way to see what the
                // engine wrote to stderr when it dies before producing a `result` message at all.
                stderr: (data: string) => {
                    stderrTail = (stderrTail + data).slice(-STDERR_TAIL_CHARS);
                },
                mcpServers: { [REPORT_SERVER]: reportServer },
                // A backstop, not the budget. The real ceiling is enforced below and moves with the
                // denial count, which `maxTurns` cannot do once `query()` has been called. This one
                // exists so a run still terminates if that local accounting is ever wrong.
                maxTurns: stage.maxSteps * 2 + 5,
                ...(stage.maxBudgetUsd !== undefined ? { maxBudgetUsd: stage.maxBudgetUsd } : {}),
                abortController,
            },
        });
        // Called only now, rather than before `query()`: `beat()` reads context usage off `stream`
        // itself (`checkContext` above), so the first beat has to follow the assignment above it.
        beat();

        let summary = '';
        let usage: AgentRunOutput['usage'];

        // `reported` still undefined at the point a result is built, despite the report tool having
        // been seen on the stream: the call was made but never reached the callback above (or
        // reached it after this return already had to be built). That is the transport losing the
        // result, not the stage failing to finish — `stage.dispatcher.ts` phrases the two failures
        // differently and `kickback.ts` charges them differently, so the distinction has to survive
        // past this function rather than collapse back into a plain missing result.
        const droppedField = (): { resultDropped?: boolean } =>
            reported === undefined && reportToolSeen ? { resultDropped: true } : {};

        try {
            const messages = stream[Symbol.asyncIterator]();
            for (;;) {
                const next = await Promise.race([messages.next(), stopped]);
                // The losing `messages.next()` is abandoned deliberately: it stays pending on a pipe
                // that will never deliver, which is precisely the state being escaped.
                if (next === STOPPED) {
                    // No `engineStopReason` here, deliberately: the SDK has said nothing at all yet —
                    // this fires because *our own* wall-clock, idle or context guard ran out before a
                    // `result` message ever arrived, not because the SDK reported an ending.
                    // `engineFailure`/`budgetFailure` below already say which of our own controls it
                    // was; there is no SDK reason to add alongside them, and inventing one would be
                    // worse than the gap (card 0118's constraint: a confident wrong reason is worse
                    // than none).
                    return {
                        result: reported ?? (summary ? { summary } : undefined),
                        usage,
                        truncated: true,
                        ...(stoppedBecause === 'silent'
                            ? { engineFailure: engineSilent(stage.maxIdleMs) }
                            : stoppedBecause === 'context'
                              ? { budgetFailure: contextFailure }
                              : { budgetFailure: wallClockExceeded(stage.maxWallClockMs) }),
                        ...droppedField(),
                    };
                }
                // The iterator ending on its own, with no `result` message ever seen and no error
                // thrown, is the stream closing under the run rather than the model choosing to stop
                // or the process dying — card 0118's third cause, and the one the SDK gives no signal
                // for at all: nothing here to read an `engineStopReason` from, which is exactly the
                // limit `describeEngineStop` below exists to not paper over. The fallthrough return at
                // the end of this method carries none, same as an ordinary pass — there is nothing
                // truthful to put there.
                if (next.done) break;
                beat();
                const message = next.value;

                if (message.type === 'assistant') {
                    const text = message.message.content.map(part => (part.type === 'text' ? part.text : '')).join('');
                    if (text.trim()) summary = text.trim();

                    // Sticky once seen: a later message in the same run carrying only a text block
                    // must not erase that the report tool was already called earlier in this run.
                    if (!reportToolSeen) {
                        reportToolSeen = message.message.content.some(
                            part => part.type === 'tool_use' && part.name === qualifiedReportTool(),
                        );
                    }
                    if (!anyToolSeen) {
                        anyToolSeen = message.message.content.some(part => part.type === 'tool_use');
                    }

                    turns += 1;
                    // The credit a denial buys is capped at the budget itself. Uncapped, a run that
                    // is refused on every turn raises its own ceiling as fast as it consumes it and
                    // never stops — so the rule that stops refusals costing progress would instead
                    // remove the limit. Capped, the worst case is twice the budget, which is what
                    // the engine's own backstop is set to.
                    if (turns >= stage.maxSteps + Math.min(denied, stage.maxSteps)) {
                        stoppedBecause ??= 'steps';
                        this.logger.warn(`cli stage reached its step budget of ${stage.maxSteps} (${denied} refused calls not charged)`);
                        abortController.abort();
                    }
                }
                if (message.type === 'result') {
                    usage = { inputTokens: message.usage?.input_tokens, outputTokens: message.usage?.output_tokens };
                    // The engine reports its own truncation; treat anything but a clean end as cut off.
                    // That covers `error_max_budget_usd` too: it is not `success`, so it lands here.
                    if (message.subtype !== 'success') {
                        this.logger.warn(`cli stage ended as ${message.subtype}`);
                        const output = {
                            result: reported ?? (summary ? { summary } : undefined),
                            usage,
                            truncated: true,
                            budgetFailure: overBudget(usage?.inputTokens, stage.maxInputTokens),
                            // The one case this card is about: the SDK's own result message names why
                            // the run ended, and that reason is worth more than the generic "ran out of
                            // steps" text `stage.dispatcher.ts` falls back to when neither budgetFailure
                            // nor engineFailure is set — e.g. `error_max_structured_output_retries` is
                            // not a budget or an engine problem at all, and deserves its own name.
                            engineStopReason: describeEngineStop(message),
                            ...droppedField(),
                        };
                        return output;
                    }
                    // Card 0126: the turn ended cleanly and nothing was ever reported, with no tool
                    // call of any kind along the way — the shape all fifteen prior instances (cards
                    // 0010 through 0117) shared, and the only one this card has evidence for (its
                    // "one reason so far" constraint). Recorded as its own event, from inside this
                    // run rather than reconstructed afterwards from an empty diff and a missing
                    // report, so a count of `turn.empty` answers "how many times has exactly this
                    // happened" without re-parsing `engineStopReason` text off every card. Not
                    // nudged: retrying inside this same call would mean turning this adapter from a
                    // plain-string prompt into streaming input so a follow-up message could be
                    // injected mid-session — the same rework the class doc comment already declines
                    // for a narrower defect (card 0097) — and the exit condition is deliberately
                    // unchanged (this card's constraint): a missing report still fails the stage the
                    // same way it always has, on the very next lines. This just makes sure the next
                    // instance is counted rather than rediscovered from scratch.
                    if (reported === undefined && !anyToolSeen) {
                        await context.events.append({
                            project: context.project,
                            cardId: context.cardId,
                            stage: context.stage,
                            type: 'turn.empty',
                            payload: { engineStopReason: describeEngineStop(message) },
                        });
                    }
                    // The result *is* the completion signal, so act on it rather than iterating on in
                    // the hope the stream closes by itself. Claude Code under `-p
                    // --output-format=stream-json` does not exit when it finishes — it stays alive
                    // waiting for more input — and a supervisor that waits for the process instead of
                    // reading the result it already has waits forever. Reported at
                    // BloopAI/vibe-kanban#2495, where sessions sat in `running` indefinitely and idle
                    // engine processes accumulated at 200MB each.
                    return {
                        result: reported,
                        usage,
                        truncated: false,
                        budgetFailure: overBudget(usage?.inputTokens, stage.maxInputTokens),
                        // Set only when this "clean" ending still produced nothing: `reported` is
                        // undefined, meaning the model finished its turn — subtype `success` — without
                        // ever calling report_result. That is card 0118's clearest observed case (card
                        // 0115): the SDK's own `stop_reason` is the one piece of evidence for *why* it
                        // stopped there rather than reporting. Left off an ordinary pass so `stage.passed`
                        // stays exactly as noisy as it was before this card.
                        ...(reported === undefined ? { engineStopReason: describeEngineStop(message) } : {}),
                        ...droppedField(),
                    };
                }
            }
        } catch (err) {
            // Attribution comes from what the runner itself knows it did, not from the shape of the
            // error: the SDK's own abort error does not carry `name: 'AbortError'`, so matching on
            // that let every one of these fall through to a bare rethrow with no budget or engine
            // attribution at all — exactly how a run turned into `stage.failed {"error":"Claude Code
            // process aborted by user"}` with nothing else to go on. `stoppedBecause` already knows
            // which of the runner's own controls fired, if any, independent of what the error says.
            if (stoppedBecause === 'steps') {
                return {
                    result: reported ?? (summary ? { summary } : undefined),
                    usage,
                    truncated: true,
                    budgetFailure: stepsExceeded(stage.maxSteps, denied),
                    ...droppedField(),
                };
            }
            if (stoppedBecause === 'wall-clock') {
                this.logger.warn(`cli stage aborted after ${stage.maxWallClockMs}ms wall clock`);
                return {
                    result: reported ?? (summary ? { summary } : undefined),
                    usage,
                    truncated: true,
                    budgetFailure: wallClockExceeded(stage.maxWallClockMs),
                    ...droppedField(),
                };
            }
            if (stoppedBecause === 'silent') {
                return {
                    result: reported ?? (summary ? { summary } : undefined),
                    usage,
                    truncated: true,
                    engineFailure: engineSilent(stage.maxIdleMs),
                    ...droppedField(),
                };
            }
            // `abort()` alone was already shown not to reliably unblock a parked read (the comment
            // by `stoppedBecause`'s declaration above), so this mirrors that same race for the
            // context guard: usually the `STOPPED` branch above wins it, but should the abort itself
            // be what unblocks `messages.next()` instead, the reason must not be lost here either.
            if (stoppedBecause === 'context') {
                return {
                    result: reported ?? (summary ? { summary } : undefined),
                    usage,
                    truncated: true,
                    budgetFailure: contextFailure,
                    ...droppedField(),
                };
            }

            // None of the runner's own controls fired, and the read still rejected. The engine's own
            // process lifecycle tags every abnormal exit it produces — an abort, a nonzero exit, a
            // signal, a spawn failure — with an `errorClass`, and often an `exitCode` or `signal`
            // beside it. An error without that tag did not come from the engine's process at all (a
            // `ScopeKickbackError` from a kicked-back scope request is exactly this shape) and must
            // keep propagating as the bare error it is, not be reinterpreted as an engine fault.
            const tagged = err as { message?: string; errorClass?: unknown; exitCode?: unknown; signal?: unknown };
            if (typeof tagged.errorClass !== 'string') throw err;

            const exitCode = typeof tagged.exitCode === 'number' ? tagged.exitCode : undefined;
            const signal = typeof tagged.signal === 'string' ? tagged.signal : undefined;
            const message = tagged.message ?? String(err);

            await context.events.append({
                project: context.project,
                cardId: context.cardId,
                stage: context.stage,
                type: 'engine.failed',
                payload: {
                    message,
                    errorClass: tagged.errorClass,
                    ...(exitCode !== undefined ? { exitCode } : {}),
                    ...(signal !== undefined ? { signal } : {}),
                    ...(stderrTail ? { stderr: stderrTail } : {}),
                },
            });

            const detail = [
                message,
                exitCode !== undefined ? `exit code ${exitCode}` : undefined,
                signal !== undefined ? `signal ${signal}` : undefined,
                stderrTail ? `stderr: ${stderrTail}` : undefined,
            ]
                .filter((part): part is string => Boolean(part))
                .join(' — ');
            this.logger.warn(`cli stage engine exited with none of the runner's controls firing: ${detail}`);
            return {
                result: reported ?? (summary ? { summary } : undefined),
                usage,
                truncated: true,
                engineFailure: `the engine aborted or exited on its own — none of the runner's wall-clock, idle or step controls fired — ${detail}`,
                ...droppedField(),
            };
        } finally {
            clearTimeout(wallClock);
            clearTimeout(idle);
            // Every exit from this method abandons the stream, including the successful one. Abort so
            // the engine is torn down explicitly rather than left to whatever cleanup breaking out of
            // a `for await` happens to trigger — that assumption is what leaves orphaned processes
            // behind. Inert when the run already ended on its own.
            abortController.abort();
            // The fixed name only — not whatever `path` a call actually read from, which may be a
            // file legitimately in scope and none of this adapter's business to delete. Unconditional
            // and swallowed: absent is the common case (the file was never written, or report_result
            // already read it), and this must run whether the stage passed, failed, was truncated, or
            // aborted, so this file never reaches a diff. The scratch directory gets the same
            // treatment, recursively — it may hold anything the stage wrote for its own inspection,
            // and letting any of it survive would turn SCRATCH_PREFIX into a second, uncontrolled
            // `alwaysAllowed` entry instead of the throwaway path it is meant to be.
            await unlink(join(context.worktreeRoot, REPORT_RESULT_PATH)).catch(() => {});
            await rm(join(context.worktreeRoot, SCRATCH_PREFIX), { recursive: true, force: true }).catch(() => {});
        }

        // A stage that never called the report tool did not say it had finished, and the dispatcher
        // treats an absent result as exactly that. The prose summary is a fallback for the truncated
        // case only, never a substitute for a structured report.
        const output = {
            result: reported,
            usage,
            truncated: false,
            budgetFailure: overBudget(usage?.inputTokens, stage.maxInputTokens),
            ...droppedField(),
        };
        return output;
    }
}

/**
 * Put `ScopeGuard` and `CommandAllowlist` back in the path.
 *
 * Reads go through the read check, writes through the full scope check, and Bash through the
 * command allowlist — the same three decisions the `api` adapter's tools make, at the only point
 * the engine offers for making them. Exported rather than private because it is the whole of this
 * adapter's enforcement, and a live model declining to misbehave is not evidence that a guard works.
 *
 * `onDeny` fires for every refusal. It is the one choke point every denial passes through, which is
 * what makes refused calls cheap to exclude from the step budget.
 */
/**
 * What the read loses to when a timer fires first.
 *
 * A unique object rather than a string or `undefined`, so the race result can be told apart from a
 * legitimate stream message by identity alone.
 */
const STOPPED = Symbol('stopped');

/**
 * What the SDK itself says about why a `result` message's turn ended: its `subtype` (`'success'`,
 * `'error_max_turns'`, `'error_during_execution'`, ...) plus, when the engine set one, the
 * underlying model's own `stop_reason` (`'end_turn'`, `'max_tokens'`, `'tool_use'`,
 * `'model_context_window_exceeded'`, ...). This is the one place `query()`'s stream volunteers a
 * reason for anything (card 0118's constraint: "the SDK already knows... this card records it
 * rather than inferring it") — every other `engineStopReason` site in this file has no `result`
 * message to read one from, and says so instead of guessing.
 *
 * Distinguishing "the model finished its turn and stopped" from "the stream closed" is exactly
 * what this cannot do beyond what `subtype`/`stop_reason` already say: a `success` subtype here
 * means the SDK is certain the turn ended cleanly, not that the model chose to; there is no further
 * signal in the message for that finer question, so none is invented.
 */
const describeEngineStop = (message: { subtype: string; stop_reason: string | null }): string =>
    message.stop_reason ? `ended as '${message.subtype}' (stop_reason: ${message.stop_reason})` : `ended as '${message.subtype}'`;

/**
 * Parses and validates the contents of the file `report_result` was pointed at, against this
 * stage's own result schema. The tool call itself carries only a path now (see the class doc
 * comment for why), so this is the one place left that checks the result actually has the shape the
 * stage promised — nothing upstream of it can any more.
 */
const parseReportedResult = (text: string, resultSchema: z.ZodTypeAny): { ok: true; value: unknown } | { ok: false; reason: string } => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        return { ok: false, reason: `is not valid JSON: ${(err as Error).message}` };
    }
    const validated = resultSchema.safeParse(parsed);
    if (!validated.success) {
        return { ok: false, reason: `does not match this stage's result schema: ${validated.error.message}` };
    }
    return { ok: true, value: validated.data };
};

/** `2` -> `'2nd'`, `11` -> `'11th'`, `23` -> `'23rd'`. Used only to phrase the repeat count below. */
const ordinal = (n: number): string => {
    if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
    switch (n % 10) {
        case 1:
            return `${n}st`;
        case 2:
            return `${n}nd`;
        case 3:
            return `${n}rd`;
        default:
            return `${n}th`;
    }
};

/**
 * The shape a repeated denial is grouped by: the command's leading token for Bash, the path for a
 * scope denial, the bare tool name otherwise. Not a precise dedupe — `find /` and `find . -name x`
 * share a shape on purpose, because a denial message that named the tool once already answered both.
 */
const denialShapeFor = (toolName: string, detail: Record<string, unknown>): string => {
    if (typeof detail.command === 'string' && detail.command.trim()) {
        return `${toolName}:${detail.command.trim().split(/\s+/)[0]?.toLowerCase()}`;
    }
    if (typeof detail.path === 'string' && detail.path) {
        return `${toolName}:${detail.path}`;
    }
    return toolName;
};

export const createToolGuard = (context: ToolContext, writable: string, onDeny?: () => void, onActivity?: () => void): CanUseTool => {
    // How many times each denial shape has fired in this run. Scoped to this call, which the
    // dispatcher makes fresh per stage run, so it never sees a shape from a different stage or a
    // different card. The denial message already names the right tool on the first refusal — card
    // 0001 spent four calls on `find /` variants before it named `find` as unavailable at all. What
    // it does not do is notice a *second* refusal of the same shape, so an agent that gets denied,
    // reads the message, and tries again anyway — new flags, a pipe, a different quoting — gets the
    // identical sentence back and nothing that says the retry itself was the mistake. This card
    // measured three such runs burning turns exactly that way (card 0083); the fix is a message that
    // differs on repeat, not just a message that is already correct the first time.
    const repeats = new Map<string, number>();

    return async (toolName, input): Promise<PermissionResult> => {
        // Every tool call is a sign of life, refused or not. The engine emits nothing on the stream
        // for the duration of a tool call, so this is the only evidence the adapter gets that a long
        // `pnpm test` is a working stage rather than a dead one.
        onActivity?.();

        const deny = async (reason: string, detail: Record<string, unknown>): Promise<PermissionResult> => {
            const shape = denialShapeFor(toolName, detail);
            const count = (repeats.get(shape) ?? 0) + 1;
            repeats.set(shape, count);
            const message =
                count === 1
                    ? reason
                    : `This is the ${ordinal(count)} time this has been refused in this run, in this shape — repeating it will not produce a different answer. ${reason}`;

            await context.events.append({
                project: context.project,
                cardId: context.cardId,
                stage: context.stage,
                type: 'tool.denied',
                payload: { tool: toolName, reason: message, ...detail },
            });
            onDeny?.();
            return { behavior: 'deny', message };
        };

        if (WRITE_TOOLS.includes(toolName)) {
            const path = String(input.file_path ?? input.path ?? '');
            const decision = await context.scope.check(path);
            // REPORT_RESULT_PATH is let through regardless of `writable`, mirroring the unconditional
            // allow already built into ScopeGuard.check/checkRead/grant for that same path (see
            // scope.guard.ts). report_result's contract requires the stage to have written this file
            // before calling the tool, and a readonly or none stage — review chief among them, the
            // stage this card names as least able to afford a lost result — still has to deliver one.
            // The scratch prefix gets the same bypass for the same reason: `check` already allows it
            // unconditionally, and gating on `writable` here as well would silently take that back
            // for exactly the readonly stage — review — this exists to serve.
            if (writable !== 'rw' && decision.path !== REPORT_RESULT_PATH && !decision.path.startsWith(SCRATCH_PREFIX)) {
                return deny(`this stage is ${writable}: it may not write`, { tool: toolName });
            }
            if (!decision.allowed) return deny(decision.reason, { path });
            // The counterpart to the denial above: file.tools.ts/bash.tool.ts append tool.executed
            // for the api adapter, but Write/Edit here go through the engine's own built-in tools
            // and this callback rather than through those files, so this adapter has to record it
            // itself at the only point it decides to allow the call.
            await context.events.append({
                project: context.project,
                cardId: context.cardId,
                stage: context.stage,
                type: 'tool.executed',
                payload: { tool: toolName, path: decision.path },
            });
            return { behavior: 'allow' };
        }

        if (READ_TOOLS.includes(toolName)) {
            const path = String(input.file_path ?? input.path ?? input.pattern ?? '');
            // Glob and Grep carry patterns rather than paths; only check when it looks like one.
            if (!path || !input.file_path) return { behavior: 'allow' };
            const decision = await context.scope.checkRead(path);
            return decision.allowed ? { behavior: 'allow' } : deny(decision.reason, { path });
        }

        if (EXEC_TOOLS.includes(toolName)) {
            const command = String(input.command ?? '');
            const decision = context.commands.check(command);
            if (!decision.allowed) return deny(decision.reason, { command });
            // Recorded once the command is allowed, not gated on its exit code — same reasoning as
            // bash.tool.ts's tool.executed append: a failing command still ran, and knowing it ran
            // is the point. This callback only sees the proposed call, not its result, so that is
            // the only point it can record it at.
            await context.events.append({
                project: context.project,
                cardId: context.cardId,
                stage: context.stage,
                type: 'tool.executed',
                payload: { tool: toolName, command },
            });
            return { behavior: 'allow' };
        }

        // This adapter's own report tool, supplied as an in-process MCP server. Allowed
        // unconditionally: the path it takes is only ever read, never written, through this
        // callback, and containment/denial for that read is `checkRead`'s job inside the tool's own
        // handler above, not this guard's.
        if (toolName === qualifiedReportTool()) {
            return { behavior: 'allow' };
        }

        // Likewise this adapter's own request_scope tool, but only for an `rw` stage — the same
        // condition that keeps it off the MCP server in the first place. A readonly or none stage can
        // never write, so it must not be able to request a widening it could never use either. When
        // present, it is allowed unconditionally: it writes nothing itself, and the widen/kickback
        // decision is `requestScope`'s to make, not the guard's — the same split the api adapter's
        // tool set makes between this tool and ScopeGuard.
        if (toolName === qualifiedRequestScopeTool()) {
            return writable === 'rw' ? { behavior: 'allow' } : deny(`this stage is ${writable}: it may not write`, { tool: toolName });
        }

        // This adapter's own delete tool, present on the MCP server only for an `rw` stage (see
        // above). `deleteFile` does its own `ScopeGuard.check` and event logging, the same split
        // `request_scope`/`requestScope` already makes — the guard here only gates on writability,
        // exactly as it does for request_scope.
        if (toolName === qualifiedDeleteTool()) {
            return writable === 'rw' ? { behavior: 'allow' } : deny(`this stage is ${writable}: it may not write`, { tool: toolName });
        }

        // Card 0097, task 2: could a bare `delete` — the wrong name board config used to hand a
        // stage — be caught here and answered with the qualified one? No, and not for lack of a
        // branch to add. This callback only ever runs for a `toolName` the engine itself already
        // recognises as a real tool (a built-in, or one of this MCP server's own) that this
        // stage's policy happens not to allow — that is what the catch-all `deny` below is for. A
        // name outside that whole surface, like a bare `delete`, is rejected by the engine's own
        // dispatcher with "No such tool available: delete" before a permission decision is ever
        // requested — there is nothing to permission-check for a tool that does not exist. That
        // rejection does reach the message stream, as a `user` message carrying the tool_result
        // answering the model's tool_use block (required by the API's own protocol), but by the
        // time this adapter's read loop below observes it the engine has already moved the turn
        // on: feeding a correction back in would mean writing into the running query, which the
        // SDK only exposes via `streamInput` on an `AsyncIterable` prompt, and this adapter starts
        // `query()` from a plain string. Rebuilding the call around streaming input to open that
        // one narrow correction path is a bigger change than this defect is worth. Task 1's fix —
        // naming the tool right before the model ever has to guess — is what actually prevents it.
        return deny(`${toolName} is not available to this stage`, {});
    };
};
