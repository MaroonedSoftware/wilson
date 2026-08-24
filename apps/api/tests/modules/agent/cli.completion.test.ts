import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0028. The engine's `result` message is the completion signal, and this adapter has to act on
 * it rather than wait for the stream to close.
 *
 * Claude Code under `-p --output-format=stream-json` does not exit when it finishes — it stays alive
 * waiting for more input on stdin. A supervisor that waits for the process instead of reading the
 * result it already has waits forever: BloopAI/vibe-kanban#2495 reported sessions stuck in `running`
 * indefinitely, post-completion work never running, and idle engine processes accumulating at 200MB
 * each. We have a wall-clock abort that would eventually fire, so the failure here is thirty minutes
 * of a held concurrency slot rather than a permanent hang — worse once cards start themselves.
 *
 * `query` is mocked for the same reason the other adapter suites mock it: what is under test is what
 * this adapter does with what comes back, not the engine's judgement.
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

const runInput = (stage: ReturnType<typeof makeStage>) => ({
    stage,
    context: { worktreeRoot: '/tmp/worktree' },
    planPath: '/run/plan.md',
    title: 'a card',
    resultSchema: z.object({ summary: z.string().optional() }),
});

const successResult = { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } };

describe('CliStageAgent completion', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    /**
     * The engine that never ends its own stream. Yields the result, then blocks forever, which is
     * precisely the shape vibe-kanban hit. A run that consumes past the result never returns.
     */
    const streamThatNeverEnds = (messages: unknown[]) => ({
        async *[Symbol.asyncIterator]() {
            for (const message of messages) yield message;
            await new Promise(() => {});
        },
    });

    const streamOf = (messages: unknown[]) => ({
        async *[Symbol.asyncIterator]() {
            for (const message of messages) yield message;
        },
    });

    it('returns on a successful result rather than waiting for the engine to close the stream', async () => {
        queryMock.mockReturnValue(streamThatNeverEnds([successResult]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = await Promise.race([
            agent.run(runInput(makeStage()) as never),
            new Promise((_, reject) => setTimeout(() => reject(new Error('never returned')), 1000)),
        ]);

        expect((output as { truncated: boolean }).truncated).toBe(false);
        expect((output as { usage?: { inputTokens?: number } }).usage?.inputTokens).toBe(10);
    });

    it('aborts the engine on the way out, so a stream it abandons is torn down rather than orphaned', async () => {
        queryMock.mockReturnValue(streamThatNeverEnds([successResult]));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage()) as never);

        const call = queryMock.mock.calls[0]?.[0] as { options: { abortController: AbortController } };
        expect(call.options.abortController.signal.aborted).toBe(true);
    });

    it('aborts on the truncated path too, not only the successful one', async () => {
        queryMock.mockReturnValue(streamThatNeverEnds([{ ...successResult, subtype: 'error_max_turns' }]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = await agent.run(runInput(makeStage()) as never);

        expect((output as { truncated: boolean }).truncated).toBe(true);
        const call = queryMock.mock.calls[0]?.[0] as { options: { abortController: AbortController } };
        expect(call.options.abortController.signal.aborted).toBe(true);
    });

    it('still returns when the stream ends without ever sending a result', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = await agent.run(runInput(makeStage()) as never);

        // No report tool call and no result: the dispatcher reads an absent result as "did not finish".
        expect((output as { result?: unknown }).result).toBeUndefined();
        expect((output as { truncated: boolean }).truncated).toBe(false);
    });
});
