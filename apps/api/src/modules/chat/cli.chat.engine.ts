import { createSdkMcpServer, query, tool, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Injectable } from 'injectkit';
import { subscriptionEnv } from '#modules/agent/cli.stage.agent.js';
import { CLAUDE_CONFIG_DIR } from '#modules/settings/claude.config.dir.setting.js';
import { describeUsageLimit, UsageLimitWatch } from '#modules/agent/usage.limit.js';
import { EngineAccountsService, LOCAL_ACCOUNT } from '#modules/host/engine.accounts.service.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { MAX_CHAT_STEPS } from './api.chat.engine.js';
import { ChatEngine, type ChatTurnInput, type ChatTurnOutput } from './chat.engine.js';

/** The in-process MCP server the chat's tools are served from; the engine sees them as `mcp__wilson-chat__<name>`. */
export const CHAT_SERVER = 'wilson-chat';

/**
 * A thread with history but no session to resume — one started on the 'api' engine never is, but a
 * session can be lost (a cleared config dir) — starts a fresh session with the conversation so far
 * written into its first prompt, rather than losing it.
 */
const withTranscript = (history: ChatTurnInput['history'], text: string): string =>
    history.length === 0
        ? text
        : [
              'The conversation so far, for context:',
              ...history.map(message => `${message.role === 'user' ? 'Person' : 'You'}: ${message.content}`),
              '',
              `Person: ${text}`,
          ].join('\n\n');

/** The tools this message offers or attempts that are not served from {@link CHAT_SERVER}. */
const foreignTools = (message: SDKMessage): string[] => {
    const names =
        message.type === 'system' && message.subtype === 'init'
            ? message.tools
            : message.type === 'assistant'
              ? message.message.content.flatMap(part => (part.type === 'tool_use' ? [part.name] : []))
              : [];
    return names.filter(name => !name.startsWith(`mcp__${CHAT_SERVER}__`));
};

const assertOwnTools = (message: SDKMessage): void => {
    const foreign = foreignTools(message);
    if (foreign.length > 0) throw new Error(`the engine reached for a tool it was not given: ${foreign.join(', ')}`);
};

/**
 * The 'cli' engine: the Claude Agent SDK on the operator's subscription (`subscriptionEnv`, the same
 * credentials planning and `cli` stages use), resuming the thread's own session each turn rather
 * than replaying it, which is why it stores `engineSessionId` and no `engineMessages`.
 *
 * The tool surface is the chat's five tools and nothing else: `tools: []` turns every built-in tool
 * off (no Bash, no file access), and `settingSources: []` with `strictMcpConfig: true` keeps the host
 * machine's own settings and MCP servers out, as `CliStageAgent` does. The five are listed in
 * `allowedTools`, pre-approving them: there is no one at a terminal to approve a call, and none of
 * them can change anything (a change is only ever proposed, a question only ever asked, `chatTools`).
 */
@Injectable()
export class CliChatEngine extends ChatEngine {
    constructor(
        private readonly settings: SettingsStore,
        private readonly accounts?: EngineAccountsService,
    ) {
        super();
    }

    async turn({
        thread,
        history,
        text,
        system,
        tools,
        model,
        maxSteps = MAX_CHAT_STEPS,
        onlyOwnTools = false,
        onText,
    }: ChatTurnInput): Promise<ChatTurnOutput> {
        const account = await this.accounts?.local();
        if (account?.limit) throw new Error(describeUsageLimit(account.limit));
        const usageWatch = new UsageLimitWatch(account?.name ?? LOCAL_ACCOUNT);
        const server = createSdkMcpServer({
            name: CHAT_SERVER,
            tools: tools.map(chatTool =>
                tool(chatTool.name, chatTool.description, chatTool.input.shape, async input => ({
                    content: [{ type: 'text' as const, text: await chatTool.execute(input as Record<string, unknown>) }],
                })),
            ),
        });

        const stream = query({
            prompt: thread.engineSessionId ? text : withTranscript(history, text),
            options: {
                // Sessions are stored per working directory, so every turn of every thread runs from
                // the same one, or `resume` would not find the session the last turn left.
                cwd: process.cwd(),
                model,
                systemPrompt: system,
                tools: [],
                mcpServers: { [CHAT_SERVER]: server },
                allowedTools: tools.map(chatTool => `mcp__${CHAT_SERVER}__${chatTool.name}`),
                settingSources: [],
                strictMcpConfig: true,
                includePartialMessages: true,
                maxTurns: maxSteps,
                env: subscriptionEnv(await this.settings.get(CLAUDE_CONFIG_DIR), account?.token, account?.variable),
                ...(thread.engineSessionId ? { resume: thread.engineSessionId } : {}),
            },
        });

        let streamed = '';
        let written = '';
        let sessionId: string | undefined;
        let usage: ChatTurnOutput['usage'];
        for await (const message of stream) {
            usageWatch.observe(message);
            if (onlyOwnTools) assertOwnTools(message);
            if ('session_id' in message && message.session_id) sessionId = message.session_id;
            if (message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
                streamed += message.event.delta.text;
                onText?.(message.event.delta.text);
            } else if (message.type === 'assistant') {
                written += message.message.content.map(part => (part.type === 'text' ? part.text : '')).join('');
            } else if (message.type === 'result') {
                if (usageWatch.limit) {
                    await this.accounts?.recordLimit(usageWatch.limit);
                    throw new Error(describeUsageLimit(usageWatch.limit));
                }
                if (message.subtype !== 'success')
                    throw new Error(`the engine stopped (${message.subtype}): ${message.errors.join('; ') || 'no reason given'}`);
                usage = message.usage ? { outputTokens: message.usage.output_tokens } : undefined;
                break;
            }
        }

        // The streamed deltas are the answer as the person watched it arrive; the completed blocks
        // are the fallback for an engine build that sends no partial messages.
        return { text: streamed || written, engineSessionId: sessionId, usage };
    }
}
