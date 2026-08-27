import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0093: nothing stopped a stage before it overflowed the context window. `maxInputTokens`
 * bounds what a run has already spent; it says nothing about the request the *next* turn is about
 * to build, so a run could sit comfortably under that cap and still blow the model's context window
 * on a single turn. This wires `Query.getContextUsage()`'s own `percentage` into the same beat the
 * idle guard already reads on, and stops the run through the same `abortController` path a
 * wall-clock or step-budget cutoff uses — see `cli.stage.agent.budget.test.ts` and
 * `cli.step.budget.test.ts` for the sibling budgets this one has to read the same as.
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
    maxSteps: 1000,
    maxOutputTokens: 16000,
    maxInputTokens: 2_000_000,
    maxWallClockMs: 60_000,
    maxContextWindowFraction: 0.9,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
    ...overrides,
});

const runInput = (stage: ReturnType<typeof makeStage>) => ({
    stage,
    context: { worktreeRoot: '/tmp/worktree', events: { append: async () => {} } },
    planPath: '/run/plan.md',
    title: 'a card',
    resultSchema: z.object({ summary: z.string().optional() }),
});

const assistantMessage = () => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });

/**
 * A stream that never produces a `result` on its own — only the context guard (or, in a control
 * case, nothing at all) ends the run — yielding an assistant message every `gapMs` so `beat()` fires
 * repeatedly. `getContextUsage` walks through `percentages` one call at a time, holding on the last
 * entry once exhausted, so a short list can still be read as many times as there are beats.
 */
const contextStream = (percentages: number[], gapMs = 5) => {
    let call = 0;
    return {
        async *[Symbol.asyncIterator]() {
            for (;;) {
                await new Promise(r => setTimeout(r, gapMs));
                yield assistantMessage();
            }
        },
        getContextUsage: async () => {
            const percentage = percentages[Math.min(call, percentages.length - 1)];
            call += 1;
            return { percentage };
        },
    };
};

/** A stream with no `getContextUsage` at all — models an engine version the SDK type predates. */
const plainStream = (messages: unknown[]) => ({
    async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
    },
});

const resultMessage = (inputTokens: number) => ({ type: 'result', subtype: 'success', usage: { input_tokens: inputTokens, output_tokens: 5 } });

describe('CliStageAgent context budget', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    it('stops the run once reported context usage crosses the configured fraction', async () => {
        // Climbs past the default 0.9 cap (90%) on the third beat; nothing else in this stream ever
        // ends the run, so only the context guard can be what stops it.
        queryMock.mockReturnValue(contextStream([30, 60, 95]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as { truncated: boolean; budgetFailure?: string };

        expect(output.truncated).toBe(true);
        expect(output.budgetFailure).toMatch(/context window budget exceeded/);
        expect(output.budgetFailure).toContain('cap 90%');
        expect(output.budgetFailure).toContain('observed 95%');
    }, 10_000);

    it('aborts the engine’s own abortController when the context cap is crossed', async () => {
        queryMock.mockReturnValue(contextStream([95]));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage()) as never);

        const call = queryMock.mock.calls[0]?.[0] as { options: { abortController: AbortController } };
        expect(call.options.abortController.signal.aborted).toBe(true);
    }, 10_000);

    it('does not report the context cutoff as an engine failure, a step failure or a wall-clock failure', async () => {
        queryMock.mockReturnValue(contextStream([95]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as { engineFailure?: string; budgetFailure?: string };

        // An operator reading the wrong cap name goes and raises a cap that was never the problem —
        // the same reasoning `cli.step.budget.test.ts` and `cli.heartbeat.test.ts` pin down for
        // their own budgets.
        expect(output.engineFailure).toBeUndefined();
        expect(output.budgetFailure).not.toMatch(/wall-clock/);
        expect(output.budgetFailure).not.toMatch(/step budget/);
        expect(output.budgetFailure).not.toMatch(/input token/);
    }, 10_000);

    it('respects a stage-configured fraction narrower than the default', async () => {
        // 60% crosses a 0.5 cap but sits comfortably under the 0.9 default, so this only fires
        // because the configured fraction, not a hardcoded one, is what the guard compares against.
        queryMock.mockReturnValue(contextStream([60]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage({ maxContextWindowFraction: 0.5 })) as never)) as { budgetFailure?: string };

        expect(output.budgetFailure).toMatch(/cap 50%/);
        expect(output.budgetFailure).toMatch(/observed 60%/);
    }, 10_000);

    it('leaves a run untouched while reported context usage stays under the cap', async () => {
        // Every beat reports comfortably under the 0.9 cap, and the stream ends cleanly on its own —
        // the context guard must never fire here.
        queryMock.mockReturnValue({
            async *[Symbol.asyncIterator]() {
                yield assistantMessage();
                yield resultMessage(100);
            },
            getContextUsage: async () => ({ percentage: 10 }),
        });
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as { truncated: boolean; budgetFailure?: string };

        expect(output.truncated).toBe(false);
        expect(output.budgetFailure).toBeUndefined();
    });

    it('runs to a clean completion when the stream carries no getContextUsage at all', async () => {
        // A stream shaped like every other fixture in this suite — no context-usage capability —
        // must not throw synchronously out of the beat that tries to read it, only be swallowed.
        queryMock.mockReturnValue(plainStream([assistantMessage(), resultMessage(50)]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as { truncated: boolean; budgetFailure?: string };

        expect(output.truncated).toBe(false);
        expect(output.budgetFailure).toBeUndefined();
    });
});
