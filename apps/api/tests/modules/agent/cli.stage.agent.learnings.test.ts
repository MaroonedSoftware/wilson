import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0244: `CliStageAgent.run` now takes an optional `learningsPath` (`AgentRunInput`) and, when
 * it is set, adds one line to the prompt — next to the plan-path line — telling the agent to read
 * the project's learnings before starting, framed as guidance to follow rather than material to
 * weigh. When `learningsPath` is unset (an empty or absent document — PROJECT.md decision 8), the
 * prompt must carry no learnings line at all. Follows this file's sibling
 * `cli.stage.agent.prompt.test.ts` pattern of mocking `query` and reading the captured prompt back.
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
const resultSchema = z.object({ summary: z.string().optional() });

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

const runInput = (learningsPath?: string) => ({
    stage: makeStage({ worktree: 'rw' }),
    context: fakeContext,
    planPath: '/run/plan.md',
    learningsPath,
    title: 'a card',
    resultSchema,
    baseSha: 'deadbeef',
});

/** An async iterable that resolves as a clean, empty run once exhausted. */
const emptyStream = () => ({
    async *[Symbol.asyncIterator]() {
        // no messages
    },
});

const promptFromCall = (): string => {
    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    return call.prompt;
};

describe('CliStageAgent learnings prompt wiring (card 0244)', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    it('tells the agent to read the learnings path before starting, when one is set', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput('/run/cards/0001/learnings.md') as never);

        const prompt = promptFromCall();
        expect(prompt).toContain('/run/cards/0001/learnings.md');
        expect(prompt).toContain('Before you start, also read the project');
    });

    it('frames the learnings as guidance to follow, not material to weigh', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput('/run/cards/0001/learnings.md') as never);

        expect(promptFromCall()).toContain('follow them like the plan, not material to weigh');
    });

    it('adds no learnings line at all when learningsPath is unset', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(undefined) as never);

        const prompt = promptFromCall();
        expect(prompt).not.toContain('learnings');
        expect(prompt).not.toContain('/run/cards/0001/learnings.md');
    });
});
