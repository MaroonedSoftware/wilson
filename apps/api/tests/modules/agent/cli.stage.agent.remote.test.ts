import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A stage whose worktree is on another machine runs the engine there: `query()` gets the host's
 * `spawnClaude` as `spawnClaudeCodeProcess`, and `claude` as the executable so the SDK passes its
 * flags straight through. On this machine neither key is set, so the call is exactly what it was.
 * `query` is mocked for the reason `cli.stage.agent.sandbox.test.ts` gives.
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
const { MemoryHost } = await import('#tests/support/memory.host.js');
const { z } = await import('zod');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const stage = {
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
    sandboxAllowedDomains: [],
};

const runInput = (context: Record<string, unknown>) => ({
    stage,
    context: { worktreeRoot: '/remote/wt/0001', ...context },
    planPath: '/remote/run/cards/0001/plan.md',
    title: 'a card',
    resultSchema: z.object({ summary: z.string().optional() }),
    baseSha: 'deadbeef',
});

const emptyStream = () => ({
    async *[Symbol.asyncIterator]() {
        // no messages
    },
});

const options = (): Record<string, unknown> => (queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;

describe('CliStageAgent runs the engine where the worktree is', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    it('leaves the SDK’s own spawn alone on this machine', async () => {
        queryMock.mockReturnValue(emptyStream());

        await new CliStageAgent(silentLogger as never).run(runInput({}) as never);

        expect('spawnClaudeCodeProcess' in options()).toBe(false);
        expect('pathToClaudeCodeExecutable' in options()).toBe(false);
    });

    it('hands the SDK the host’s spawn, and claude as the executable, for a host that can start it', async () => {
        queryMock.mockReturnValue(emptyStream());
        const host = new MemoryHost();
        const spawned = { fake: 'process' };
        const spawnClaude = vi.fn(() => spawned);
        Object.assign(host, { spawnClaude });

        await new CliStageAgent(silentLogger as never).run(runInput({ host }) as never);

        expect(options().pathToClaudeCodeExecutable).toBe('claude');
        const spawn = options().spawnClaudeCodeProcess as (o: unknown) => unknown;
        const spawnOptions = { command: 'claude', args: ['--print'], cwd: '/remote/wt/0001', env: {} };
        expect(spawn(spawnOptions)).toBe(spawned);
        expect(spawnClaude).toHaveBeenCalledWith(spawnOptions);
    });
});
