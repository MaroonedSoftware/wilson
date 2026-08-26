import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { createSdkMcpServer, query, tool, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { engineSilent, overBudget, stepsExceeded, wallClockExceeded } from './budget.js';
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
 */
export const subscriptionEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
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
const qualifiedDeleteTool = (): string => `mcp__${REPORT_SERVER}__${DELETE_TOOL}`;

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
 */
@Injectable()
export class CliStageAgent extends StageAgent {
    constructor(private readonly logger: Logger) {
        super();
    }

    async run({ stage, context, planPath, title, resultSchema }: AgentRunInput): Promise<AgentRunOutput> {
        // The engine has no equivalent of the api adapter's report tool, so one is supplied as an
        // in-process MCP server carrying this stage's own result schema. Without it a stage can only
        // hand back prose, which the review verifier rightly refuses — card 0014 failed its review
        // on a missing `verdict` and was kicked back to implementing for a defect no amount of
        // re-implementing could fix.
        let reported: unknown;
        // A `report_result` tool_use block appearing in the stream is the model having called the
        // tool, independent of whether the callback above ever ran to set `reported` — see
        // `droppedField` below, near the returns, for why that gap matters and what it is charged as.
        let reportToolSeen = false;
        // The api adapter's buildTools only exposes request_scope when worktreeMode === 'rw' — a
        // readonly or none stage can never write, so granting it the tool would let it log
        // scope.requested/granted events (or trip ScopeKickbackError under the kickback policy) for a
        // widening it could never use. This adapter honours the same condition rather than exposing
        // the tool unconditionally.
        const canWrite = stage.worktree === 'rw';
        const reportServer = createSdkMcpServer({
            name: REPORT_SERVER,
            tools: [
                tool(
                    REPORT_TOOL,
                    'Report the work you have completed and end the stage. Call this exactly once, only after you have made every change the plan asks for and the build passes.',
                    (resultSchema as z.ZodObject<z.ZodRawShape>).shape,
                    async input => {
                        reported = input;
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
        let stoppedBecause: 'wall-clock' | 'silent' | 'steps' | undefined;
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
        const beat = (): void => {
            if (!idleGuards) return;
            clearTimeout(idle);
            idle = setTimeout(() => {
                stoppedBecause ??= 'silent';
                abortController.abort();
                stop();
            }, stage.maxIdleMs);
            idle.unref();
        };
        beat();

        const stream = query({
            prompt: [
                `Card: ${title}`,
                '',
                `Your plan is at ${planPath}. Read it before anything else. Its "Files in scope" is what`,
                `you may change and its "Out of scope" is binding even where you could make the change.`,
                '',
                `You are in a git worktree at ${context.worktreeRoot}.`,
                '',
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
                      ]
                    : []),
                `When the work is done and the build passes, call ${qualifiedReportTool()} with your result.`,
                'Work first, report last: that call ends the stage, and a result describing work you did',
                'not do fails it, because the runner checks the diff and not your summary.',
            ].join('\n'),
            options: {
                cwd: context.worktreeRoot,
                // 'default' so canUseTool is consulted rather than bypassed. Never
                // 'bypassPermissions': that is precisely the guard this adapter has to re-add.
                permissionMode: 'default',
                canUseTool: createToolGuard(
                    context,
                    stage.worktree,
                    () => {
                        denied += 1;
                    },
                    beat,
                ),
                env: subscriptionEnv(),
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
                    return {
                        result: reported ?? (summary ? { summary } : undefined),
                        usage,
                        truncated: true,
                        ...(stoppedBecause === 'silent'
                            ? { engineFailure: engineSilent(stage.maxIdleMs) }
                            : { budgetFailure: wallClockExceeded(stage.maxWallClockMs) }),
                        ...droppedField(),
                    };
                }
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
                            ...droppedField(),
                        };
                        return output;
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
            if (writable !== 'rw') {
                return deny(`this stage is ${writable}: it may not write`, { tool: toolName });
            }
            const path = String(input.file_path ?? input.path ?? '');
            const decision = await context.scope.check(path);
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
        // unconditionally: it writes nothing and takes no path, and the schema it must satisfy is
        // enforced by the stage's verifier rather than here.
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

        return deny(`${toolName} is not available to this stage`, {});
    };
};
