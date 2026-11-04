import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '#tests/support/fake.settings.js';

const { queryMock, generateTextMock } = vi.hoisted(() => ({ queryMock: vi.fn(), generateTextMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', async original => ({
    ...(await original<typeof import('@anthropic-ai/claude-agent-sdk')>()),
    query: queryMock,
}));
vi.mock('ai', async original => ({ ...(await original<typeof import('ai')>()), generateText: generateTextMock }));

const { ApiRuleJudgeEngine, CliRuleJudgeEngine } = await import('#modules/rules/rule.judge.engine.js');

const call = () => ({
    system: 'sys',
    prompt: 'the prompt',
    provider: 'anthropic' as const,
    model: 'claude-sonnet-5-5',
    signal: new AbortController().signal,
});

const stream = (...messages: unknown[]) =>
    (async function* () {
        yield* messages;
    })();

const init = (tools: string[] = []) => ({ type: 'system', subtype: 'init', tools });
const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const success = {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 20, output_tokens: 3 },
};

describe('CliRuleJudgeEngine', () => {
    beforeEach(() => queryMock.mockReset());

    it('asks once, with no tools, no host settings and no session kept', async () => {
        queryMock.mockReturnValue(stream(init(), assistant('{"verdict":"pass"}'), success));

        const reply = await new CliRuleJudgeEngine(defaultSettings).ask(call());

        expect(reply).toEqual({
            text: '{"verdict":"pass"}',
            usage: { inputTokens: 5, cachedInputTokens: 30, cacheWriteInputTokens: 20, outputTokens: 3 },
        });
        expect(queryMock.mock.calls[0]![0]).toMatchObject({
            prompt: 'the prompt',
            options: {
                model: 'claude-sonnet-5-5',
                systemPrompt: 'sys',
                tools: [],
                mcpServers: {},
                settingSources: [],
                strictMcpConfig: true,
                maxTurns: 1,
                persistSession: false,
            },
        });
    });

    it('fails a call whose engine offers a tool anyway', async () => {
        queryMock.mockReturnValue(stream(init(['Bash']), assistant('{}'), success));

        await expect(new CliRuleJudgeEngine(defaultSettings).ask(call())).rejects.toThrow(/Bash/);
    });

    it('fails a call whose engine reaches for a tool', async () => {
        queryMock.mockReturnValue(stream(init(), { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }, success));

        await expect(new CliRuleJudgeEngine(defaultSettings).ask(call())).rejects.toThrow(/Read/);
    });

    it('fails a call the engine ended badly, or never finished', async () => {
        queryMock.mockReturnValueOnce(stream({ type: 'result', subtype: 'error_max_turns', errors: ['too long'] }));
        await expect(new CliRuleJudgeEngine(defaultSettings).ask(call())).rejects.toThrow(/too long/);

        queryMock.mockReturnValueOnce(stream(init()));
        await expect(new CliRuleJudgeEngine(defaultSettings).ask(call())).rejects.toThrow(/without a result/);
    });

    it('aborts the engine when the signal does', async () => {
        const controller = new AbortController();
        queryMock.mockReturnValue(
            (async function* () {
                controller.abort();
                yield success;
            })(),
        );

        await new CliRuleJudgeEngine(defaultSettings).ask({ ...call(), signal: controller.signal });

        const { options } = queryMock.mock.calls[0]![0] as { options: { abortController: AbortController } };
        expect(options.abortController.signal.aborted).toBe(true);
    });

    it('does not spend on an account already at its limit', async () => {
        const accounts = { local: async () => ({ name: 'a', limit: { kind: 'x', resetsAt: undefined } }) };

        await expect(new CliRuleJudgeEngine(defaultSettings, accounts as never).ask(call())).rejects.toThrow();
        expect(queryMock).not.toHaveBeenCalled();
    });
});

describe('ApiRuleJudgeEngine', () => {
    it('makes one call with no tools, and reads usage the way a stage does', async () => {
        generateTextMock.mockResolvedValue({
            text: 'answer',
            usage: { inputTokens: 30, outputTokens: 2, inputTokenDetails: { cacheReadTokens: 10, cacheWriteTokens: 5 } },
        });
        const models = { resolve: vi.fn(() => 'model') };
        const { signal } = new AbortController();

        const reply = await new ApiRuleJudgeEngine(models as never).ask({ ...call(), signal });

        expect(reply).toEqual({ text: 'answer', usage: { inputTokens: 15, outputTokens: 2, cachedInputTokens: 15, cacheWriteInputTokens: 5 } });
        expect(generateTextMock.mock.calls[0]![0]).toMatchObject({ model: 'model', instructions: 'sys', prompt: 'the prompt', abortSignal: signal });
        expect(generateTextMock.mock.calls[0]![0].tools).toBeUndefined();
    });
});
