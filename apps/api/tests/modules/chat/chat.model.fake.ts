import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import type { ModelRegistry } from '#modules/agent/model.registry.js';

/**
 * A provider stream part, loosely typed: `@ai-sdk/provider`, which declares the exact union, is not a
 * dependency of this package, only of `ai`'s.
 */
type StreamPart = Record<string, unknown> & { type: string };

const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** One model step that writes `text`. */
export const says = (text: string): StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
];

/** One model step that calls `toolName` with `input`, optionally saying something first. */
export const calls = (toolName: string, input: unknown, before?: string): StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    ...(before
        ? ([
              { type: 'text-start', id: 'b' },
              { type: 'text-delta', id: 'b', delta: before },
              { type: 'text-end', id: 'b' },
          ] as StreamPart[])
        : []),
    { type: 'tool-call', toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
];

/**
 * A scripted model: each call answers the next step in `steps`, and every prompt it was given is kept
 * so a test can see what the engine replayed. Wrapped as the `ModelRegistry` `ApiChatEngine` takes.
 */
export const scriptedModel = (steps: StreamPart[][]) => {
    const prompts: unknown[] = [];
    let next = 0;
    const model = new MockLanguageModelV4({
        doStream: async options => {
            prompts.push(options.prompt);
            const step = steps[next++];
            if (!step) throw new Error(`the scripted model has no step ${next}`);
            return { stream: convertArrayToReadableStream(step as never) };
        },
    });
    const registry = { resolve: () => model } as unknown as ModelRegistry;
    return { registry, prompts, steps };
};
