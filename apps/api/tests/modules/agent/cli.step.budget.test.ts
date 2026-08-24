import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0038. A refused tool call produces no work, so it must not spend a step.
 *
 * 62% of this board's 518 denials were the agent reaching for a shell that does not exist — pipes,
 * `;`, `2>&1`. Charging each one a step is what turns that friction into failure: card 0032's first
 * attempt died on its step limit with roughly a dozen steps spent that way.
 *
 * The engine owns `maxTurns` and cannot be told to raise it once `query()` has been called, so the
 * real ceiling is enforced here and moves with the denial count. The engine's own limit stays as a
 * backstop against the local accounting being wrong.
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
    maxSteps: 5,
    maxOutputTokens: 16000,
    maxInputTokens: 2_000_000,
    maxWallClockMs: 1_800_000,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
    ...overrides,
});

const appended: unknown[] = [];

const runInput = (stage: ReturnType<typeof makeStage>) => ({
    stage,
    context: {
        project: 'test',
        cardId: '0001',
        stage: 'implementing',
        worktreeRoot: '/tmp/worktree',
        events: { append: async (e: unknown) => void appended.push(e) },
        logger: silentLogger,
    },
    planPath: '/run/plan.md',
    title: 'a card',
    resultSchema: z.object({ summary: z.string().optional() }),
});

const assistantMessage = () => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });

/**
 * A stream that never ends on its own, yielding `turns` assistant messages and calling the adapter's
 * own permission guard `denialsPerTurn` times before each. `WebFetch` is refused unconditionally, so
 * it exercises the deny path without needing a scope guard or a command allowlist.
 */
type MockOptions = { canUseTool: (n: string, i: unknown) => Promise<unknown>; abortController: AbortController; maxTurns: number };

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

const streamOf = (turns: number, denialsPerTurn = 0) => ({
    async *[Symbol.asyncIterator]() {
        const options = (queryMock.mock.calls[0]?.[0] as { options: MockOptions }).options;
        const { signal } = options.abortController;
        for (let turn = 0; turn < turns; turn++) {
            // The engine's own ceiling, modelled so the backstop is exercised rather than assumed.
            if (turn >= options.maxTurns) {
                yield { type: 'result', subtype: 'error_max_turns', usage: { input_tokens: 1, output_tokens: 1 } };
                return;
            }
            for (let d = 0; d < denialsPerTurn; d++) await options.canUseTool('WebFetch', {});
            yield assistantMessage();
            // The engine ends the run when its abort controller fires; a mock that ignored the
            // signal would hang here instead, and prove nothing about the budget that triggered it.
            if (signal.aborted) throw abortError();
        }
    },
});

/** A stream that yields once and then stalls, so only the wall clock can end the run. */
const stallingStream = () => ({
    async *[Symbol.asyncIterator]() {
        const options = (queryMock.mock.calls[0]?.[0] as { options: MockOptions }).options;
        yield assistantMessage();
        await new Promise((_, reject) => options.abortController.signal.addEventListener('abort', () => reject(abortError())));
    },
});

describe('CliStageAgent step budget', () => {
    afterEach(() => {
        queryMock.mockReset();
        appended.length = 0;
    });

    it('gives the engine a ceiling above the configured budget, as a backstop rather than the budget', async () => {
        queryMock.mockReturnValue(streamOf(1));
        await new CliStageAgent(silentLogger as never).run(runInput(makeStage({ maxSteps: 5 })) as never);

        const call = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
        expect(call.options.maxTurns).toBe(15);
    });

    it('stops at the configured budget when nothing is refused', async () => {
        queryMock.mockReturnValue(streamOf(50));
        const output = await new CliStageAgent(silentLogger as never).run(runInput(makeStage({ maxSteps: 5 })) as never);

        expect(output.truncated).toBe(true);
        expect(output.budgetFailure).toBe('step budget exceeded: 5 steps');
    });

    /**
     * The point of the card. With one refusal before every turn the ceiling moves up in step, so the
     * run still gets its five productive steps rather than being cut off at five total calls.
     */
    it('does not charge refused calls, so a run keeps its full allowance of productive steps', async () => {
        queryMock.mockReturnValue(streamOf(50, 1));
        const output = await new CliStageAgent(silentLogger as never).run(runInput(makeStage({ maxSteps: 5 })) as never);

        // One refusal per turn, so ten turns pass before the ceiling binds — five of them productive.
        // Charged the old way, the run would have been cut off at five turns having done half the work.
        expect(output.truncated).toBe(true);
        expect(output.budgetFailure).toMatch(/5 steps, with 10 refused calls not charged/);
    });

    /**
     * The credit a denial buys has to be capped, or a run refused on every turn raises its ceiling as
     * fast as it spends it and never stops — the rule meant to stop refusals costing progress would
     * instead remove the limit. Twice the budget is the worst case, matching the engine's backstop.
     */
    it('caps the credit, so a run refused on every turn still terminates', async () => {
        queryMock.mockReturnValue(streamOf(500, 3));
        const output = await new CliStageAgent(silentLogger as never).run(runInput(makeStage({ maxSteps: 4 })) as never);

        expect(output.truncated).toBe(true);
        expect(output.budgetFailure).toMatch(/step budget exceeded/);
    }, 20000);

    it('records every refusal it declined to charge', async () => {
        queryMock.mockReturnValue(streamOf(50, 2));
        await new CliStageAgent(silentLogger as never).run(runInput(makeStage({ maxSteps: 3 })) as never);

        expect(appended.filter((e): e is { type: string } => (e as { type: string }).type === 'tool.denied').length).toBeGreaterThan(0);
    });

    it('reports the wall clock, not the step budget, when time is what ran out', async () => {
        queryMock.mockReturnValue(stallingStream());
        const output = await new CliStageAgent(silentLogger as never).run(runInput(makeStage({ maxSteps: 100, maxWallClockMs: 1000 })) as never);

        // One turn, then the stream stalls: the wall-clock timer is the only thing that can end it.
        expect(output.budgetFailure).toMatch(/wall-clock budget exceeded/);
    }, 10000);
});
