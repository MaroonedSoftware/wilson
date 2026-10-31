import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0015 wired budget caps into the `cli` adapter too: "both adapters or neither" is a hard
 * constraint, because every stage currently runs through `cli` — a cap that only worked as an AI SDK
 * `stopWhen` would do nothing here, since the Claude Code engine runs its own loop.
 *
 * `query` is mocked rather than driven against a real engine, matching `cli.tool.guard.test.ts`'s
 * own reasoning: what's under test is what this adapter wires into the engine and does with what
 * comes back, not the engine's own judgement.
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
const { z } = await import('zod');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const makeStage = (overrides = {}) => ({
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
    maxSteps: 60,
    maxOutputTokens: 16000,
    maxInputTokens: 2_000_000,
    maxWallClockMs: 1_800_000,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
    ...overrides,
});

// `events` is a required stub, not an unused one: card 0126's turn.empty detection appends an
// event whenever a run ends cleanly with no tool call and nothing reported, which several of this
// file's fixtures do on purpose to exercise the budget wiring in isolation.
const fakeContext = { worktreeRoot: '/tmp/worktree', events: { append: async () => {} } };
const resultSchema = z.object({ summary: z.string().optional() });

const runInput = (stage: ReturnType<typeof makeStage>) => ({
    stage,
    context: fakeContext,
    planPath: '/run/plan.md',
    title: 'a card',
    resultSchema,
});

/** An async iterable of `message`s that resolves as a clean, empty run once exhausted. */
const streamOf = (messages: unknown[]) => ({
    async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
    },
});

const resultMessage = (subtype: string, inputTokens: number) => ({
    type: 'result',
    subtype,
    usage: { input_tokens: inputTokens, output_tokens: 5 },
});

describe('CliStageAgent budget wiring', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    describe('input tokens during a run', () => {
        const assistant = (id: string, inputTokens: number) => ({
            type: 'assistant',
            message: { id, usage: { input_tokens: inputTokens, output_tokens: 1 }, content: [{ type: 'text', text: 'working' }] },
        });

        it('stops the run when its input tokens reach the cap, without waiting for a result', async () => {
            queryMock.mockReturnValue(streamOf([assistant('msg_1', 600), assistant('msg_2', 900), assistant('msg_3', 900)]));

            const output = await new CliStageAgent(silentLogger).run(runInput(makeStage({ maxInputTokens: 1000 })) as never);

            expect(output.truncated).toBe(true);
            expect(output.budgetFailure).toBe('input token budget exceeded: used 1500, cap 1000');
            expect(output.usage?.inputTokens).toBe(1500);
        });

        it('reports what the run read and last said, however it ended', async () => {
            const read = (id: string, input: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input }] } });
            const said = { type: 'assistant', message: { content: [{ type: 'text', text: 'gave up here' }] } };
            queryMock.mockReturnValue(streamOf([read('t1', { file_path: 'src/a.ts' }), read('t2', { file_path: 'src/a.ts' }), said, assistant('msg_1', 1500)]));

            const output = await new CliStageAgent(silentLogger).run(runInput(makeStage({ maxInputTokens: 1000 })) as never);

            expect(output.trace).toEqual({ reads: 2, readPaths: ['src/a.ts'], finalMessage: 'working' });
        });

        it('charges an API message once, however many content blocks repeat its usage', async () => {
            queryMock.mockReturnValue(streamOf([assistant('msg_1', 600), assistant('msg_1', 600), assistant('msg_1', 600), resultMessage('success', 600)]));

            const output = await new CliStageAgent(silentLogger).run(runInput(makeStage({ maxInputTokens: 1000 })) as never);

            expect(output.budgetFailure).toBeUndefined();
            expect(output.truncated).toBe(false);
        });
    });

    /**
     * Card 0038 changed what `maxTurns` means here. It used to be the budget; it is now a backstop,
     * because refused calls must not spend steps and the engine cannot be told to raise its own
     * ceiling once `query()` has been called. The real budget is enforced in the adapter and moves
     * with the denial count, so this only checks the engine is left enough room for it to bind first.
     */
    it('gives the engine a ceiling above the stage’s budget, leaving room for uncharged refusals', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage({ maxSteps: 17 })) as never);

        const call = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
        expect(call.options.maxTurns).toBeGreaterThan(17);
    });

    it('passes maxBudgetUsd through to the engine when the stage sets one', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage({ maxBudgetUsd: 3.5 })) as never);

        const call = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
        expect(call.options.maxBudgetUsd).toBe(3.5);
    });

    it('omits maxBudgetUsd entirely when the stage does not set one, rather than passing undefined', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage()) as never);

        const call = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
        expect('maxBudgetUsd' in call.options).toBe(false);
    });

    it('wires an abortController into the engine’s options', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage()) as never);

        const call = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
        expect(call.options.abortController).toBeInstanceOf(AbortController);
    });

    it('treats the engine’s error_max_budget_usd result subtype as truncated, same as any other non-success subtype', async () => {
        queryMock.mockReturnValue(streamOf([resultMessage('error_max_budget_usd', 100)]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as { truncated: boolean };

        expect(output.truncated).toBe(true);
    });

    it('reports a budgetFailure once the reported input tokens meet the cap', async () => {
        queryMock.mockReturnValue(streamOf([resultMessage('success', 1000)]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage({ maxInputTokens: 1000 })) as never)) as { budgetFailure?: string };

        expect(output.budgetFailure).toContain('used 1000, cap 1000');
    });

    it('leaves budgetFailure undefined while the reported input tokens stay under the cap', async () => {
        queryMock.mockReturnValue(streamOf([resultMessage('success', 500)]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage({ maxInputTokens: 1000 })) as never)) as { budgetFailure?: string };

        expect(output.budgetFailure).toBeUndefined();
    });

    it('aborts the run once the wall clock expires, and fails the stage rather than hanging or throwing', async () => {
        // No message ever arrives; the stream only ever settles because the wall-clock timeout aborts
        // the shared `abortController`, exactly as it would for a stuck real engine.
        queryMock.mockImplementation(({ options }: { options: { abortController: AbortController } }) => ({
            [Symbol.asyncIterator]() {
                return {
                    next: () =>
                        new Promise((_resolve, reject) => {
                            options.abortController.signal.addEventListener('abort', () => {
                                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                            });
                        }),
                };
            },
        }));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage({ maxWallClockMs: 20 })) as never)) as {
            truncated: boolean;
            budgetFailure?: string;
        };

        expect(output.truncated).toBe(true);
        // Distinct from the input-token overBudget message: a wall-clock cutoff must name
        // maxWallClockMs specifically, not read as if the token cap were what was hit.
        expect(output.budgetFailure).toBe('wall-clock budget exceeded: cap 20ms');
    }, 10_000);
});
