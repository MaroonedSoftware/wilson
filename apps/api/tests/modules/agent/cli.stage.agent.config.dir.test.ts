import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0141: `CliStageAgent` now takes an optional `SettingsStore` and resolves the
 * `claude-config-dir` setting once per `run`, passing it through `subscriptionEnv` into the `env`
 * handed to `query()` as `CLAUDE_CONFIG_DIR`. Before this card `subscriptionEnv()` took no argument
 * and never set that key at all — every case here fails on the pre-change tree because
 * `CLAUDE_CONFIG_DIR` never appears in the engine's environment no matter what the fake store
 * resolves.
 *
 * `query` is mocked rather than driven against a real engine, matching `cli.stage.agent.prompt.test
 * .ts`'s own reasoning: what's under test is the environment this adapter builds, not the engine's
 * own judgement.
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
const { CLAUDE_CONFIG_DIR } = await import('#modules/settings/claude.config.dir.setting.js');
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
    baseSha: 'deadbeef',
});

/** An async iterable that resolves as a clean, empty run once exhausted. */
const emptyStream = () => ({
    async *[Symbol.asyncIterator]() {
        // no messages
    },
});

const envFromCall = (): NodeJS.ProcessEnv => {
    const call = queryMock.mock.calls[0]?.[0] as { options: { env: NodeJS.ProcessEnv } };
    return call.options.env;
};

/** A `SettingsStore` fake that resolves whatever `configDir` it is given for every `get` call. */
const fakeSettingsStore = (configDir: string | undefined) => ({ get: vi.fn(async () => configDir) });

describe('CliStageAgent resolves the claude-config-dir setting into the engine environment', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    it('sets CLAUDE_CONFIG_DIR in the engine env when the setting resolves to a directory', async () => {
        queryMock.mockReturnValue(emptyStream());
        const settings = fakeSettingsStore('/home/operator/.claude-wilson');
        const agent = new CliStageAgent(silentLogger as never, settings as never);

        await agent.run(runInput(makeStage()) as never);

        expect(settings.get).toHaveBeenCalledWith(CLAUDE_CONFIG_DIR);
        expect(envFromCall().CLAUDE_CONFIG_DIR).toBe('/home/operator/.claude-wilson');
    });

    it('carries no CLAUDE_CONFIG_DIR key at all when the setting resolves to undefined (unset)', async () => {
        queryMock.mockReturnValue(emptyStream());
        const settings = fakeSettingsStore(undefined);
        const agent = new CliStageAgent(silentLogger as never, settings as never);

        await agent.run(runInput(makeStage()) as never);

        expect('CLAUDE_CONFIG_DIR' in envFromCall()).toBe(false);
    });

    it('carries no CLAUDE_CONFIG_DIR key at all when constructed with no settings store', async () => {
        queryMock.mockReturnValue(emptyStream());
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage()) as never);

        expect('CLAUDE_CONFIG_DIR' in envFromCall()).toBe(false);
    });

    it('still deletes both provider API key variables from the engine env regardless of the resolved config dir', async () => {
        const original = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
        process.env.ANTHROPIC_API_KEY = 'sk-should-not-reach-the-engine';
        process.env.ANTHROPIC_AUTH_TOKEN = 'tok-should-not-reach-the-engine';
        try {
            queryMock.mockReturnValue(emptyStream());
            const settings = fakeSettingsStore('/home/operator/.claude-wilson');
            const agent = new CliStageAgent(silentLogger as never, settings as never);

            await agent.run(runInput(makeStage()) as never);

            const env = envFromCall();
            expect(env.ANTHROPIC_API_KEY).toBeUndefined();
            expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
            expect(env.CLAUDE_CONFIG_DIR).toBe('/home/operator/.claude-wilson');
        } finally {
            if (original.key === undefined) delete process.env.ANTHROPIC_API_KEY;
            else process.env.ANTHROPIC_API_KEY = original.key;
            if (original.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
            else process.env.ANTHROPIC_AUTH_TOKEN = original.token;
        }
    });
});
