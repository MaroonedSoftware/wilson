import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0260: a cli stage can run inside the engine's own OS-level sandbox, off by default. Whether
 * `query()` receives a `sandbox` option at all — and, when it does, exactly what it contains — turns
 * entirely on `stage.sandbox`/`stage.sandboxAllowedDomains`, already resolved by `findStage`
 * (`stage.config.ts`) before this adapter ever sees them. `query` is mocked here rather than driven
 * against a real engine, matching `cli.tool.surface.settings.test.ts`'s own reasoning: what's under
 * test is what this adapter wires into the call, not the engine's own judgement of what those options
 * mean. Before this card the `...(stage.sandbox ? {...} : {})` spread did not exist at all, so no
 * stage shape here — sandbox true or false — ever produced a `sandbox` key on the pre-change tree.
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

const makeStage = (overrides: Record<string, unknown> = {}) => ({
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
    // Present on every real StageConfig `findStage` returns (defaults to `[]`) — never absent, the
    // way `sandbox` itself may be.
    sandboxAllowedDomains: [],
    ...overrides,
});

const fakeContext = { worktreeRoot: '/tmp/worktree' };
const resultSchema = z.object({ summary: z.string().optional() });

const runInput = (stage: ReturnType<typeof makeStage>) => ({
    stage,
    context: fakeContext,
    planPath: '/run/cards/0260/plan.md',
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

const optionsFromCall = (): Record<string, unknown> => {
    const call = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
    return call.options;
};

describe('CliStageAgent wires stage.sandbox into query()', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    it('AC1: passes no sandbox option at all when stage.sandbox is unset — the call stays byte-for-byte what it is today', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage()) as never);

        expect('sandbox' in optionsFromCall()).toBe(false);
    });

    it('passes no sandbox option when stage.sandbox is explicitly false (already resolved that way by findStage)', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage({ sandbox: false })) as never);

        expect('sandbox' in optionsFromCall()).toBe(false);
    });

    it('AC2/AC3: passes the full sandbox block when stage.sandbox is true', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage({ sandbox: true, sandboxAllowedDomains: ['example.com'] })) as never);

        expect(optionsFromCall().sandbox).toEqual({
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: false,
            // The card's own worktree, and the plan/learnings directory under runRoot (dirname of
            // planPath) — nothing else.
            filesystem: { allowWrite: ['/tmp/worktree', '/run/cards/0260'] },
            network: { allowedDomains: ['example.com'], strictAllowlist: true },
        });
    });

    it('AC4: an empty allowedDomains list stays empty rather than becoming a wildcard', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage({ sandbox: true, sandboxAllowedDomains: [] })) as never);

        const sandbox = optionsFromCall().sandbox as { network: { allowedDomains: string[]; strictAllowlist: boolean } };
        expect(sandbox.network.allowedDomains).toEqual([]);
        expect(sandbox.network.strictAllowlist).toBe(true);
    });

    it('AC4: passes the configured domain list through verbatim, in order', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(
            runInput(makeStage({ sandbox: true, sandboxAllowedDomains: ['a.example.com', 'b.example.com'] })) as never,
        );

        const sandbox = optionsFromCall().sandbox as { network: { allowedDomains: string[] } };
        expect(sandbox.network.allowedDomains).toEqual(['a.example.com', 'b.example.com']);
    });

    it.each(['rw', 'readonly', 'none'] as const)(
        'AC3: scopes filesystem.allowWrite to the worktree and plan directory for a %s stage too',
        async worktree => {
            queryMock.mockReturnValue(emptyStream());
            const agent = new CliStageAgent(silentLogger as never);

            await agent.run(runInput(makeStage({ worktree, sandbox: true })) as never);

            const sandbox = optionsFromCall().sandbox as { filesystem: { allowWrite: string[] } };
            expect(sandbox.filesystem.allowWrite).toEqual(['/tmp/worktree', '/run/cards/0260']);
        },
    );
});
