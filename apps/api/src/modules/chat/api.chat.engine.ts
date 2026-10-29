import { Injectable } from 'injectkit';
import { stepCountIs, streamText, tool, type ModelMessage, type ToolSet } from 'ai';
import { ModelRegistry } from '#modules/agent/model.registry.js';
import type { ChatMessage } from './chat.message.repository.js';
import { ChatEngine, type ChatTurnInput, type ChatTurnOutput } from './chat.engine.js';

/** Tool-loop steps one turn may take: plenty for a few searches, reads and a proposal, and a stop for a model that loops. */
export const MAX_CHAT_STEPS = 20;

/**
 * The thread so far, as the AI SDK takes it. An answer replays its own `engineMessages` (the turn's
 * response messages, tool calls and results included) so the model keeps what it read last time; an
 * answer stored without them, such as one written by the 'cli' engine, replays as its text alone.
 */
const replay = (history: ChatMessage[]): ModelMessage[] =>
    history.flatMap((message): ModelMessage[] =>
        message.role === 'user'
            ? [{ role: 'user', content: message.content }]
            : Array.isArray(message.engineMessages)
              ? (message.engineMessages as ModelMessage[])
              : [{ role: 'assistant', content: message.content }],
    );

/**
 * The 'api' engine: the AI SDK's `streamText`, against a provider API key (`ModelRegistry`), the same
 * path `ApiStageAgent` runs stages on. Replays the stored thread every turn rather than holding a
 * session, which is why it keeps `engineMessages`.
 */
@Injectable()
export class ApiChatEngine extends ChatEngine {
    constructor(private readonly models: ModelRegistry) {
        super();
    }

    async turn({ history, text, system, tools, provider, model, onText }: ChatTurnInput): Promise<ChatTurnOutput> {
        const toolSet: ToolSet = Object.fromEntries(
            tools.map(chatTool => [
                chatTool.name,
                tool({
                    description: chatTool.description,
                    inputSchema: chatTool.input,
                    execute: async (input: Record<string, unknown>) => chatTool.execute(input),
                }),
            ]),
        );

        const result = streamText({
            model: this.models.resolve(provider, model),
            instructions: system,
            messages: [...replay(history), { role: 'user', content: text }],
            tools: toolSet,
            stopWhen: stepCountIs(MAX_CHAT_STEPS),
        });

        // Every step's text, not just the last step's: an answer often says what it is about to look
        // up before the tool call that looks it up.
        let answer = '';
        for await (const part of result.fullStream) {
            if (part.type === 'text-delta') {
                answer += part.text;
                onText?.(part.text);
            } else if (part.type === 'error') {
                throw part.error instanceof Error ? part.error : new Error(String(part.error));
            }
        }

        return { text: answer, engineMessages: await result.responseMessages };
    }
}
