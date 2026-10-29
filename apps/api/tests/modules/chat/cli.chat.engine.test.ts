import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { ChatMessage } from '#modules/chat/chat.message.repository.js';
import type { ChatThread } from '#modules/chat/chat.thread.repository.js';
import type { ChatTool } from '#modules/chat/chat.tools.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

/**
 * `query` is mocked, as in `plan.session.agent.test.ts`: what is under test is the call this engine
 * makes — what tool surface it gives the engine, and how it reads the stream back — not the engine.
 * `createSdkMcpServer` and `tool` pass their arguments through so the served tools can be called.
 */
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: queryMock,
    createSdkMcpServer: (config: unknown) => config,
    tool: (name: string, description: string, shape: unknown, handler: unknown) => ({ name, description, shape, handler }),
}));

const { CHAT_SERVER, CliChatEngine } = await import('#modules/chat/cli.chat.engine.js');

const settings = { get: async () => undefined } as unknown as SettingsStore;

const thread = (engineSessionId?: string): ChatThread => ({
    id: '7',
    title: 'a thread',
    engine: 'cli',
    engineSessionId,
    createdAt: DateTime.now(),
    updatedAt: DateTime.now(),
});

const listCards: ChatTool = {
    name: 'dispatch_readonly',
    description: 'Run a read.',
    input: z.object({ name: z.string() }),
    execute: vi.fn(async (input: Record<string, unknown>) => `ran ${String(input.name)}`),
};

const delta = (text: string) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    session_id: 's-1',
});

const engineReplying = (messages: unknown[]) =>
    queryMock.mockImplementationOnce(() =>
        (async function* () {
            yield* messages;
        })(),
    );

const optionsOf = () => (queryMock.mock.calls.at(-1)![0] as { prompt: string; options: Record<string, unknown> }).options;
const promptOf = () => (queryMock.mock.calls.at(-1)![0] as { prompt: string }).prompt;

describe('CliChatEngine', () => {
    afterEach(() => queryMock.mockReset());

    const turn = (overrides: Partial<Parameters<InstanceType<typeof CliChatEngine>['turn']>[0]> = {}) =>
        new CliChatEngine(settings).turn({
            thread: thread(),
            history: [],
            text: 'what is in review?',
            system: 'the system prompt',
            tools: [listCards],
            provider: 'anthropic',
            model: 'claude-sonnet-5-5',
            ...overrides,
        });

    it('gives the engine only the chat tools: no built-in tools, no host settings or MCP servers', async () => {
        engineReplying([{ type: 'result', subtype: 'success', session_id: 's-1' }]);

        await turn();

        const options = optionsOf();
        expect(options.tools).toEqual([]);
        expect(options.settingSources).toEqual([]);
        expect(options.strictMcpConfig).toBe(true);
        expect(options.allowedTools).toEqual([`mcp__${CHAT_SERVER}__dispatch_readonly`]);
        expect(options.systemPrompt).toBe('the system prompt');
        expect(options.model).toBe('claude-sonnet-5-5');
        expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    });

    it("serves each chat tool's execute through the in-process MCP server", async () => {
        engineReplying([{ type: 'result', subtype: 'success', session_id: 's-1' }]);
        await turn();

        const served = (optionsOf().mcpServers as Record<string, { tools: { name: string; handler: (input: unknown) => Promise<unknown> }[] }>)[
            CHAT_SERVER
        ]!;
        const result = await served.tools[0]!.handler({ name: 'list_cards' });

        expect(result).toEqual({ content: [{ type: 'text', text: 'ran list_cards' }] });
    });

    it('streams the answer as it is written, and reports the session to resume', async () => {
        engineReplying([delta('One card'), delta(': 0007.'), { type: 'result', subtype: 'success', session_id: 's-1' }]);
        const pieces: string[] = [];

        const output = await turn({ onText: piece => pieces.push(piece) });

        expect(pieces).toEqual(['One card', ': 0007.']);
        expect(output).toEqual({ text: 'One card: 0007.', engineSessionId: 's-1' });
    });

    it('falls back to the completed blocks when the engine streams no deltas', async () => {
        engineReplying([
            { type: 'assistant', message: { content: [{ type: 'text', text: 'Done looking.' }] }, session_id: 's-1' },
            { type: 'result', subtype: 'success', session_id: 's-1' },
        ]);

        expect((await turn()).text).toBe('Done looking.');
    });

    it("resumes the thread's session, sending only the new message", async () => {
        engineReplying([{ type: 'result', subtype: 'success', session_id: 's-9' }]);

        await turn({ thread: thread('s-9'), history: [{ role: 'user', content: 'earlier' } as ChatMessage] });

        expect(optionsOf().resume).toBe('s-9');
        expect(promptOf()).toBe('what is in review?');
    });

    it('writes the conversation so far into the first prompt of a thread with no session', async () => {
        engineReplying([{ type: 'result', subtype: 'success', session_id: 's-2' }]);

        await turn({
            history: [{ role: 'user', content: 'what is in review?' } as ChatMessage, { role: 'assistant', content: 'One card.' } as ChatMessage],
            text: 'which one?',
        });

        expect(optionsOf()).not.toHaveProperty('resume');
        expect(promptOf()).toContain('Person: what is in review?');
        expect(promptOf()).toContain('You: One card.');
        expect(promptOf()).toContain('Person: which one?');
    });

    it('fails a turn the engine stops short of finishing, with its reason', async () => {
        engineReplying([{ type: 'result', subtype: 'error_max_turns', errors: ['too many steps'], session_id: 's-1' }]);

        await expect(turn()).rejects.toThrow('the engine stopped (error_max_turns): too many steps');
    });
});
