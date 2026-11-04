import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A run repeating one tool call is stopped by the stream it was seen on, and blamed for that rather
 * than for whichever budget would have stopped it later.
 */
const { queryMock, mcpServerMock, toolMock } = vi.hoisted(() => ({
    queryMock: vi.fn(),
    mcpServerMock: vi.fn(() => ({})),
    toolMock: vi.fn(() => ({})),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: queryMock,
    createSdkMcpServer: mcpServerMock,
    tool: toolMock,
}));

const { CliStageAgent } = await import('#modules/agent/cli.stage.agent.js');
const { REPEATED_CALL_LIMIT } = await import('#modules/agent/repeated.call.js');
const { z } = await import('zod');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const stage = {
    name: 'implementing',
    mode: 'agent',
    worktree: 'rw',
    adapter: 'cli',
    provider: 'anthropic',
    model: 'claude-opus',
    instructions: 'do the thing',
    allowedCommands: [],
    worktreeFrom: 'base',
    extraScope: [],
    baselineCheck: true,
    maxSteps: 500,
    maxOutputTokens: 16000,
    maxInputTokens: 2_000_000,
    maxWallClockMs: 1_800_000,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
};

const runAgent = () =>
    new CliStageAgent(silentLogger as never).run({
        stage,
        context: {
            project: 'test',
            cardId: '0001',
            stage: 'implementing',
            worktreeRoot: '/tmp/worktree',
            events: { append: async () => {} },
            logger: silentLogger,
        },
        planPath: '/run/plan.md',
        title: 'a card',
        resultSchema: z.object({ summary: z.string().optional() }),
    } as never);

let nextId = 0;
const call = (name: string, input: unknown, id = `call-${nextId++}`) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
});
const answer = (id: string, isError = false) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }] },
});
const cleanEnd = { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
const test = { command: 'pnpm test' };

type Options = { options: { abortController: AbortController } };
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** Yields `messages`, then ends. Throws on abort, as the engine does. */
const streamOf = (messages: unknown[]) => ({
    async *[Symbol.asyncIterator]() {
        const { signal } = (queryMock.mock.calls[0]?.[0] as Options).options.abortController;
        for (const message of messages) {
            yield message;
            if (signal.aborted) throw abortError();
        }
    },
});

describe('CliStageAgent stopping a loop', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    it('stops at the limit and names the call, with no budget to blame', async () => {
        const seen: unknown[] = [];
        const messages = Array.from({ length: REPEATED_CALL_LIMIT + 5 }, () => call('Bash', test));
        queryMock.mockImplementation(() => ({
            async *[Symbol.asyncIterator]() {
                const { signal } = (queryMock.mock.calls[0]?.[0] as Options).options.abortController;
                for (const message of messages) {
                    seen.push(message);
                    yield message;
                    if (signal.aborted) throw abortError();
                }
            },
        }));

        const output = await runAgent();

        expect(output.loopFailure).toContain(`same Bash call ${REPEATED_CALL_LIMIT} times`);
        expect(output.truncated).toBe(true);
        expect(output.budgetFailure).toBeUndefined();
        expect(output.engineFailure).toBeUndefined();
        expect(seen).toHaveLength(REPEATED_CALL_LIMIT);
    });

    it('still names the loop when the engine never wakes up from the abort', async () => {
        queryMock.mockImplementation(() => ({
            async *[Symbol.asyncIterator]() {
                for (let turn = 0; turn < REPEATED_CALL_LIMIT; turn++) yield call('Bash', test);
                await new Promise(() => {});
            },
        }));

        const output = await runAgent();

        expect(output.loopFailure).toContain('same Bash call');
        expect(output.budgetFailure).toBeUndefined();
    });

    it('charges what the run spent, since it ends with no result to read it from', async () => {
        const costly = () => ({
            type: 'assistant',
            message: {
                id: `message-${nextId++}`,
                usage: { input_tokens: 10, output_tokens: 2 },
                content: [{ type: 'tool_use', id: `call-${nextId++}`, name: 'Bash', input: test }],
            },
        });
        queryMock.mockImplementation(() => streamOf(Array.from({ length: REPEATED_CALL_LIMIT }, costly)));

        const output = await runAgent();

        expect(output.usage).toMatchObject({ inputTokens: 10 * REPEATED_CALL_LIMIT, outputTokens: 2 * REPEATED_CALL_LIMIT });
    });

    it('does not count a Bash description the model reworded', async () => {
        const messages = Array.from({ length: REPEATED_CALL_LIMIT }, (_, turn) => call('Bash', { ...test, description: `try ${turn}` }));
        queryMock.mockImplementation(() => streamOf(messages));

        expect((await runAgent()).loopFailure).toContain('pnpm test');
    });

    it('leaves re-running the tests after each successful edit alone', async () => {
        const messages = Array.from({ length: REPEATED_CALL_LIMIT * 2 }, (_, round) => [
            call('Bash', test),
            call('Edit', { file_path: 'a.ts', old_string: String(round), new_string: String(round + 1) }, `edit-${round}`),
            answer(`edit-${round}`),
        ]).flat();
        queryMock.mockImplementation(() => streamOf([...messages, cleanEnd]));

        const output = await runAgent();

        expect(output.loopFailure).toBeUndefined();
        expect(output.truncated).toBe(false);
    });

    it('does not take a refused edit for a successful one', async () => {
        const messages = Array.from({ length: REPEATED_CALL_LIMIT }, (_, round) => [
            call('Bash', test),
            call('Edit', { file_path: 'a.ts', old_string: String(round), new_string: 'x' }, `edit-${round}`),
            answer(`edit-${round}`, true),
        ]).flat();
        queryMock.mockImplementation(() => streamOf(messages));

        expect((await runAgent()).loopFailure).toContain('same Bash call');
    });

    it('counts a write refused the same way every time', async () => {
        const write = { file_path: 'out-of-scope.ts', content: 'x' };
        const messages = Array.from({ length: REPEATED_CALL_LIMIT }, (_, round) => [
            call('Write', write, `w-${round}`),
            answer(`w-${round}`, true),
        ]).flat();
        queryMock.mockImplementation(() => streamOf(messages));

        expect((await runAgent()).loopFailure).toContain('same Write call');
    });

    it('does not count the report tool, or stop a stage that has called it', async () => {
        const report = 'mcp__wilson__report_result';
        const reports = Array.from({ length: REPEATED_CALL_LIMIT + 1 }, () => call(report, {}));
        queryMock.mockImplementation(() => streamOf([...reports, cleanEnd]));
        expect((await runAgent()).loopFailure).toBeUndefined();

        queryMock.mockReset();
        const tests = Array.from({ length: REPEATED_CALL_LIMIT }, () => call('Bash', test));
        queryMock.mockImplementation(() => streamOf([call(report, {}), ...tests, cleanEnd]));
        expect((await runAgent()).loopFailure).toBeUndefined();
    });
});
