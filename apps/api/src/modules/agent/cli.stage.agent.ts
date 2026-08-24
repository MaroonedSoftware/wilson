import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { createSdkMcpServer, query, tool, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import { overBudget, wallClockExceeded } from './budget.js';
import type { AgentRunInput, AgentRunOutput } from './stage.agent.js';
import { StageAgent } from './stage.agent.js';
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
const subscriptionEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
};

/**
 * The in-process MCP server carrying this adapter's report tool, and the name the engine exposes it
 * under. MCP tools are addressed as `mcp__<server>__<tool>`, which is what the model must call and
 * what `canUseTool` sees.
 */
const REPORT_SERVER = 'wilson';
const REPORT_TOOL = 'report_result';
const qualifiedReportTool = (): string => `mcp__${REPORT_SERVER}__${REPORT_TOOL}`;

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
            ],
            alwaysLoad: true,
        });

        // The engine has no direct "abort after this signal" option, so the timeout is wired through
        // an AbortController it does accept.
        const abortController = new AbortController();
        AbortSignal.timeout(stage.maxWallClockMs).addEventListener('abort', () => abortController.abort());

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
                `When the work is done and the build passes, call ${qualifiedReportTool()} with your result.`,
                'Work first, report last: that call ends the stage, and a result describing work you did',
                'not do fails it, because the runner checks the diff and not your summary.',
            ].join('\n'),
            options: {
                cwd: context.worktreeRoot,
                // 'default' so canUseTool is consulted rather than bypassed. Never
                // 'bypassPermissions': that is precisely the guard this adapter has to re-add.
                permissionMode: 'default',
                canUseTool: createToolGuard(context, stage.worktree),
                env: subscriptionEnv(),
                mcpServers: { [REPORT_SERVER]: reportServer },
                // The engine enforces its own bounds; `maxSteps` and the wall clock are ours to
                // configure here rather than reimplement.
                maxTurns: stage.maxSteps,
                ...(stage.maxBudgetUsd !== undefined ? { maxBudgetUsd: stage.maxBudgetUsd } : {}),
                abortController,
            },
        });

        let summary = '';
        let usage: AgentRunOutput['usage'];

        try {
            for await (const message of stream) {
                if (message.type === 'assistant') {
                    const text = message.message.content.map(part => (part.type === 'text' ? part.text : '')).join('');
                    if (text.trim()) summary = text.trim();
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
                        };
                        return output;
                    }
                }
            }
        } catch (err) {
            if ((err as { name?: string }).name === 'AbortError') {
                this.logger.warn(`cli stage aborted after ${stage.maxWallClockMs}ms wall clock`);
                return {
                    result: reported ?? (summary ? { summary } : undefined),
                    usage,
                    truncated: true,
                    budgetFailure: wallClockExceeded(stage.maxWallClockMs),
                };
            }
            throw err;
        }

        // A stage that never called the report tool did not say it had finished, and the dispatcher
        // treats an absent result as exactly that. The prose summary is a fallback for the truncated
        // case only, never a substitute for a structured report.
        const output = { result: reported, usage, truncated: false, budgetFailure: overBudget(usage?.inputTokens, stage.maxInputTokens) };
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
 */
export const createToolGuard = (context: ToolContext, writable: string): CanUseTool => {
    return async (toolName, input): Promise<PermissionResult> => {
        const deny = async (reason: string, detail: Record<string, unknown>): Promise<PermissionResult> => {
            await context.events.append({
                project: context.project,
                cardId: context.cardId,
                stage: context.stage,
                type: 'tool.denied',
                payload: { tool: toolName, reason, ...detail },
            });
            return { behavior: 'deny', message: reason };
        };

        if (WRITE_TOOLS.includes(toolName)) {
            if (writable !== 'rw') {
                return deny(`this stage is ${writable}: it may not write`, { tool: toolName });
            }
            const path = String(input.file_path ?? input.path ?? '');
            const decision = await context.scope.check(path);
            return decision.allowed ? { behavior: 'allow' } : deny(decision.reason, { path });
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
            return decision.allowed ? { behavior: 'allow' } : deny(decision.reason, { command });
        }

        // This adapter's own report tool, supplied as an in-process MCP server. Allowed
        // unconditionally: it writes nothing and takes no path, and the schema it must satisfy is
        // enforced by the stage's verifier rather than here.
        if (toolName === qualifiedReportTool()) {
            return { behavior: 'allow' };
        }

        return deny(`${toolName} is not available to this stage`, {});
    };
};
