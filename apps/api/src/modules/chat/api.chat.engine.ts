import { Injectable } from 'injectkit';
import { stepCountIs, streamText, tool, type ModelMessage, type ToolSet } from 'ai';
import { stageUsageOf } from '#modules/agent/budget.js';
import { ModelRegistry } from '#modules/agent/model.registry.js';
import { ChatEngine, type ChatImage, type ChatTurnInput, type ChatTurnOutput } from './chat.engine.js';

/** Tool-loop steps one turn may take: plenty for a few searches, reads and a proposal, and a stop for a model that loops. */
export const MAX_CHAT_STEPS = 20;

/**
 * What a person said, as the AI SDK takes it: a plain string unless there are images to send or a note
 * about ones that are not resent.
 */
const userMessage = (text: string, images: ChatImage[] = [], imageCount = images.length): ModelMessage => {
    const left = imageCount - images.length;
    if (images.length === 0 && left === 0) return { role: 'user', content: text };
    return {
        role: 'user',
        content: [
            ...images.map(image => ({ type: 'file' as const, data: image.bytes, mediaType: image.contentType })),
            ...(left > 0
                ? [{ type: 'text' as const, text: `[${left === 1 ? 'An earlier image was' : `${left} earlier images were`} attached here.]` }]
                : []),
            ...(text ? [{ type: 'text' as const, text }] : []),
        ],
    };
};

/**
 * The thread so far, as the AI SDK takes it. An answer replays its own `engineMessages` (the turn's
 * response messages, tool calls and results included) so the model keeps what it read last time; an
 * answer stored without them, such as one written by the 'cli' engine, replays as its text alone.
 */
const replay = (history: ChatTurnInput['history']): ModelMessage[] =>
    history.flatMap((message): ModelMessage[] =>
        message.role === 'user'
            ? [userMessage(message.content, message.images, message.imageCount)]
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

    async turn({ history, text, images, system, tools, provider, model, maxSteps = MAX_CHAT_STEPS, onText }: ChatTurnInput): Promise<ChatTurnOutput> {
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
            messages: [...replay(history), userMessage(text, images)],
            tools: toolSet,
            stopWhen: stepCountIs(maxSteps),
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

        const total = stageUsageOf(await result.totalUsage);
        return {
            text: answer,
            engineMessages: await result.responseMessages,
            usage:
                total.outputTokens === undefined
                    ? undefined
                    : { inputTokens: total.inputTokens, cachedInputTokens: total.cachedInputTokens, outputTokens: total.outputTokens },
        };
    }
}
