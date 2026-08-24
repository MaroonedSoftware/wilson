import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0061. A stage whose engine dies must fail on its own terms, not wait to be rescued.
 *
 * Card 0052's engine exited mid-run without emitting a `result`. The adapter was left reading a
 * stream that would never close, and — this is the part that matters — firing `abortController` did
 * nothing, because an iterator parked on a dead pipe cannot be asked to wake up. No `AbortError`, no
 * return, nothing in the log. The wall clock came and went. What eventually recovered the card was
 * pg-boss expiring the job 62 minutes later, spending one of its three retries on a run that had
 * produced nothing.
 *
 * So every test here uses a stream that ignores the abort signal. A mock that honours it models a
 * living engine being asked to stop, which is the case that already worked.
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
    maxSteps: 100,
    maxOutputTokens: 16000,
    maxInputTokens: 2_000_000,
    maxWallClockMs: 60_000,
    maxIdleMs: 300,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
    ...overrides,
});

const runInput = (stage: ReturnType<typeof makeStage>) => ({
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
});

type MockOptions = { canUseTool: (n: string, i: unknown) => Promise<unknown> };
const options = (): MockOptions => (queryMock.mock.calls[0]?.[0] as { options: MockOptions }).options;

const assistantMessage = () => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });

/** An engine that exited: one message, then a pipe that never delivers and never notices an abort. */
const deadStream = () => ({
    async *[Symbol.asyncIterator]() {
        yield assistantMessage();
        await new Promise(() => {});
    },
});

/**
 * An engine that is quiet on the wire but working: it makes tool calls, which is exactly what a long
 * `pnpm test` looks like, since nothing is emitted between requesting a tool and reporting it.
 */
const toolingStream = (calls: number, gapMs: number) => ({
    async *[Symbol.asyncIterator]() {
        yield assistantMessage();
        for (let i = 0; i < calls; i++) {
            await new Promise(r => setTimeout(r, gapMs));
            await options().canUseTool('WebFetch', {});
        }
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };
    },
});

describe('CliStageAgent heartbeat', () => {
    afterEach(() => queryMock.mockReset());

    it('abandons a run whose engine stopped producing anything', async () => {
        queryMock.mockReturnValue(deadStream());
        const started = Date.now();
        const output = await new CliStageAgent(silentLogger as never).run(runInput(makeStage()) as never);

        expect(output.engineFailure).toMatch(/produced nothing for 300ms/);
        expect(output.truncated).toBe(true);
        // The point of the card: it does not wait for the wall clock, sixty seconds away.
        expect(Date.now() - started).toBeLessThan(5_000);
    }, 10_000);

    it('does not report a dead engine as a budget failure', async () => {
        queryMock.mockReturnValue(deadStream());
        const output = await new CliStageAgent(silentLogger as never).run(runInput(makeStage()) as never);

        // An operator reading "budget exceeded" goes and raises a cap that was never the problem.
        expect(output.budgetFailure).toBeUndefined();
    }, 10_000);

    it('treats a tool call as a sign of life, so a long tool call is not mistaken for a dead engine', async () => {
        // Six gaps of 150ms each: comfortably past the 300ms window in total, never within it.
        queryMock.mockReturnValue(toolingStream(6, 150));
        const output = await new CliStageAgent(silentLogger as never).run(runInput(makeStage()) as never);

        expect(output.engineFailure).toBeUndefined();
        expect(output.truncated).toBe(false);
    }, 10_000);

    it('still enforces the wall clock when the idle guard is not armed', async () => {
        // maxIdleMs resolves to the wall clock here, so no idle timer is armed and the wall clock is
        // the only thing left — the case that silently did nothing before this card.
        queryMock.mockReturnValue(deadStream());
        const output = await new CliStageAgent(silentLogger as never).run(
            runInput(makeStage({ maxWallClockMs: 400, maxIdleMs: undefined })) as never,
        );

        expect(output.budgetFailure).toMatch(/wall-clock budget exceeded/);
        expect(output.engineFailure).toBeUndefined();
    }, 10_000);
});
