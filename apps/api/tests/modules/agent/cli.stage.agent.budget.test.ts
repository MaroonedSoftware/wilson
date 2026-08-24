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

const fakeContext = { worktreeRoot: '/tmp/worktree' };
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

    it('passes the stage’s maxSteps through as the engine’s own maxTurns', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage({ maxSteps: 17 })) as never);

        const call = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
        expect(call.options.maxTurns).toBe(17);
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
