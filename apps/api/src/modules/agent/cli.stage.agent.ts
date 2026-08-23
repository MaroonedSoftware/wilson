import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { query, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
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
 * and a denial is returned to the model as a message rather than thrown. The enforcement is
 * therefore equivalent, but it is a *bridge* rather than the tools themselves — worth remembering
 * when auditing what an agent can reach.
 */
@Injectable()
export class CliStageAgent extends StageAgent {
    constructor(private readonly logger: Logger) {
        super();
    }

    async run({ stage, context, planPath, title }: AgentRunInput): Promise<AgentRunOutput> {
        const allowedTools = [...READ_TOOLS, ...(stage.worktree === 'rw' ? [...WRITE_TOOLS, ...EXEC_TOOLS] : EXEC_TOOLS)];

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
                'When the work is done and the build passes, finish with a short summary of what you changed.',
            ].join('\n'),
            options: {
                cwd: context.worktreeRoot,
                allowedTools,
                // 'default' so canUseTool is consulted rather than bypassed. Never
                // 'bypassPermissions': that is precisely the guard this adapter has to re-add.
                permissionMode: 'default',
                canUseTool: this.guard(context),
                env: subscriptionEnv(),
            },
        });

        let summary = '';
        let usage: AgentRunOutput['usage'];

        for await (const message of stream) {
            if (message.type === 'assistant') {
                const text = message.message.content.map(part => (part.type === 'text' ? part.text : '')).join('');
                if (text.trim()) summary = text.trim();
            }
            if (message.type === 'result') {
                usage = { inputTokens: message.usage?.input_tokens, outputTokens: message.usage?.output_tokens };
                // The engine reports its own truncation; treat anything but a clean end as cut off.
                if (message.subtype !== 'success') {
                    this.logger.warn(`cli stage ended as ${message.subtype}`);
                    return { result: summary ? { summary } : undefined, usage, truncated: true };
                }
            }
        }

        return { result: summary ? { summary } : undefined, usage, truncated: false };
    }

    /**
     * Put `ScopeGuard` and `CommandAllowlist` back in the path.
     *
     * Reads are allowed through the read check, writes through the full scope check, and Bash
     * through the command allowlist — the same three decisions the `api` adapter's tools make, at
     * the only point the engine offers for making them.
     */
    private guard(context: ToolContext): CanUseTool {
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

            return deny(`${toolName} is not available to this stage`, {});
        };
    }
}
