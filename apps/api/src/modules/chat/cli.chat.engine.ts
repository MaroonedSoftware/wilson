import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { Injectable } from 'injectkit';
import { subscriptionEnv } from '#modules/agent/cli.stage.agent.js';
import { CLAUDE_CONFIG_DIR } from '#modules/settings/claude.config.dir.setting.js';
import { EngineTokenSettingService } from '#modules/settings/engine.token.setting.service.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { MAX_CHAT_STEPS } from './api.chat.engine.js';
import type { ChatMessage } from './chat.message.repository.js';
import { ChatEngine, type ChatTurnInput, type ChatTurnOutput } from './chat.engine.js';

/** The in-process MCP server the chat's tools are served from; the engine sees them as `mcp__wilson-chat__<name>`. */
export const CHAT_SERVER = 'wilson-chat';

/**
 * A thread with history but no session to resume — one started on the 'api' engine never is, but a
 * session can be lost (a cleared config dir) — starts a fresh session with the conversation so far
 * written into its first prompt, rather than losing it.
 */
const withTranscript = (history: ChatMessage[], text: string): string =>
    history.length === 0
        ? text
        : [
              'The conversation so far, for context:',
              ...history.map(message => `${message.role === 'user' ? 'Person' : 'You'}: ${message.content}`),
              '',
              `Person: ${text}`,
          ].join('\n\n');

/**
 * The 'cli' engine: the Claude Agent SDK on the operator's subscription (`subscriptionEnv`, the same
 * credentials planning and `cli` stages use), resuming the thread's own session each turn rather
 * than replaying it, which is why it stores `engineSessionId` and no `engineMessages`.
 *
 * The tool surface is the chat's four tools and nothing else: `tools: []` turns every built-in tool
 * off (no Bash, no file access), and `settingSources: []` with `strictMcpConfig: true` keeps the host
 * machine's own settings and MCP servers out, as `CliStageAgent` does. The four are listed in
 * `allowedTools`, pre-approving them: there is no one at a terminal to approve a call, and none of
 * them can change anything (a change is only ever proposed, `chatTools`).
 */
@Injectable()
export class CliChatEngine extends ChatEngine {
    constructor(
        private readonly settings: SettingsStore,
        private readonly engineTokens?: EngineTokenSettingService,
    ) {
        super();
    }

    async turn({ thread, history, text, system, tools, model, onText }: ChatTurnInput): Promise<ChatTurnOutput> {
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
                maxTurns: MAX_CHAT_STEPS,
                env: subscriptionEnv(await this.settings.get(CLAUDE_CONFIG_DIR), await this.engineTokens?.resolve()),
                ...(thread.engineSessionId ? { resume: thread.engineSessionId } : {}),
            },
        });

        let streamed = '';
        let written = '';
        let sessionId: string | undefined;
        for await (const message of stream) {
            if ('session_id' in message && message.session_id) sessionId = message.session_id;
            if (message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
                streamed += message.event.delta.text;
                onText?.(message.event.delta.text);
            } else if (message.type === 'assistant') {
                written += message.message.content.map(part => (part.type === 'text' ? part.text : '')).join('');
            } else if (message.type === 'result') {
                if (message.subtype !== 'success')
                    throw new Error(`the engine stopped (${message.subtype}): ${message.errors.join('; ') || 'no reason given'}`);
                break;
            }
        }

        // The streamed deltas are the answer as the person watched it arrive; the completed blocks
        // are the fallback for an engine build that sends no partial messages.
        return { text: streamed || written, engineSessionId: sessionId };
    }
}
