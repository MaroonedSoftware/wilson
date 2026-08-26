import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0097: board config named this adapter's delete tool as a bare `delete`, which the engine
 * rejects — MCP tools are addressed as `mcp__<server>__<tool>`, so the real name is
 * `mcp__wilson__delete`. The fix moved the guidance out of board config (which cannot know which
 * adapter will run a stage) and into this adapter, which names the tool from the same constants
 * the MCP server itself registers it under.
 *
 * `query` is mocked rather than driven against a real engine, matching `cli.stage.agent.budget.test.ts`'s
 * own reasoning: what's under test is the prompt this adapter builds, not the engine's own judgement.
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

const { CliStageAgent, qualifiedDeleteTool } = await import('#modules/agent/cli.stage.agent.js');
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

describe('CliStageAgent prompt wiring', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    it('names the delete tool by its qualified name, derived from the constant the MCP server registers it under', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage({ worktree: 'rw' })) as never);

        // Asserted against `qualifiedDeleteTool()` itself, not the literal string it currently
        // returns — the two cannot drift by construction.
        expect(promptFromCall()).toContain(qualifiedDeleteTool());
        expect(qualifiedDeleteTool()).toBe('mcp__wilson__delete');
    });

    it('never mentions a bare, unqualified "delete" — only the qualified tool name', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage({ worktree: 'rw' })) as never);

        // Every occurrence of "delete" in the prompt must be part of the qualified tool name;
        // none may stand alone the way board config's wrong paragraph used to write it.
        const bareDeletes = promptFromCall().replace(new RegExp(qualifiedDeleteTool(), 'g'), '').match(/delete/gi);
        expect(bareDeletes).toBeNull();
    });

    it('adds the skipped-test warning when the stage checks test counts', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage({ worktree: 'rw', testReportPath: 'test-report.json' })) as never);

        expect(promptFromCall()).toContain('it.skip');
    });

    it('omits the skipped-test warning when the stage has no test-count check', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage({ worktree: 'rw', testReportPath: undefined })) as never);

        expect(promptFromCall()).not.toContain('it.skip');
    });

    it('does not mention deleting at all for a readonly stage', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage({ worktree: 'readonly' })) as never);

        const prompt = promptFromCall();
        expect(prompt).not.toContain(qualifiedDeleteTool());
        expect(prompt).not.toContain('delete');
    });
});
