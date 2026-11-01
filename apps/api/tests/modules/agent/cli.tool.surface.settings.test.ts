import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0096. `cli.tool.surface.test.ts` drives a real engine and reads its `init` message to prove
 * the *resolved* tool surface is pinned — that is the only way to prove a leaked tool is actually
 * absent, not merely denied. This file covers the same change from the other, cheaper side: that
 * `CliStageAgent` itself passes `settingSources: []` and `strictMcpConfig: true` into every `query()`
 * call it makes, for every stage shape. `query` is mocked here rather than driven for real, matching
 * `cli.stage.agent.budget.test.ts`'s own reasoning: what's under test is what this adapter wires into
 * the engine, not the engine's own judgement of what those options mean. Before this card neither
 * option was passed at all, so `settingSources` was left unset — which the class doc comment (and the
 * live-engine test) establish loads the operator's own settings files and MCP servers.
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

describe('CliStageAgent pins the tool surface via query() options', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    it('passes settingSources: [] so the operator’s settings.json files are never loaded', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage()) as never);

        const call = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
        expect(call.options.settingSources).toEqual([]);
    });

    it('passes strictMcpConfig: true so only this call’s own mcpServers are connected', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage()) as never);

        const call = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
        expect(call.options.strictMcpConfig).toBe(true);
    });

    // Neither option is stage-shape-specific: a readonly or none stage's engine spawn must be just as
    // isolated from the operator's own config as an rw stage's, since both still spawn a real engine
    // with a real HOME.
    it.each(['rw', 'readonly', 'none'] as const)('pins both options for a %s stage too', async worktree => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage({ worktree })) as never);

        const call = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
        expect(call.options.settingSources).toEqual([]);
        expect(call.options.strictMcpConfig).toBe(true);
    });
});
