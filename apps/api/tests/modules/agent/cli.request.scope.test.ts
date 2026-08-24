import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0021 restored the `api` adapter's `request_scope` escape hatch on the `cli` adapter, where
 * every stage now runs: a second tool on the same in-process MCP server as `report_result`, allowed
 * through `createToolGuard`, and named in the prompt.
 *
 * `query` is mocked and `tool()` calls are captured by name rather than driven against a real
 * engine, matching `cli.stage.agent.budget.test.ts` and `cli.tool.guard.test.ts`'s own reasoning:
 * what is under test is what this adapter wires up and does with what comes back, not the engine's
 * own judgement.
 */
const { queryMock, mcpServerMock, toolMock, tools } = vi.hoisted(() => {
    const tools = new Map<string, (input: unknown) => unknown>();
    return {
        queryMock: vi.fn(),
        mcpServerMock: vi.fn(() => ({})),
        toolMock: vi.fn((name: string, _description: string, _schema: unknown, handler: (input: unknown) => unknown) => {
            tools.set(name, handler);
            return {};
        }),
        tools,
    };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: queryMock,
    createSdkMcpServer: mcpServerMock,
    tool: toolMock,
}));

const { CliStageAgent, createToolGuard } = await import('#modules/agent/cli.stage.agent.js');
const { ScopeGuard } = await import('#modules/agent/scope.guard.js');
const { CommandAllowlist } = await import('#modules/agent/command.allowlist.js');
const { ScopeKickbackError } = await import('#modules/agent/tools/tool.context.js');
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

const resultSchema = z.object({ summary: z.string().optional() });

/** An async iterable of `message`s that resolves as a clean, empty run once exhausted. */
const streamOf = (messages: unknown[]) => ({
    async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
    },
});

const buildContext = (policy: 'widen' | 'kickback' = 'widen') => {
    const events: { type: string; payload?: Record<string, unknown> }[] = [];
    return {
        project: 'p',
        cardId: '1',
        stage: 's',
        worktreeRoot: '/tmp',
        scope: new ScopeGuard({ worktreeRoot: '/tmp', allow: ['src/runner/**'], alwaysAllowed: [] }),
        commands: new CommandAllowlist(['pnpm build']),
        scopeViolationPolicy: policy,
        events: { append: async (e: { type: string; payload?: Record<string, unknown> }) => void events.push(e) },
        logger: silentLogger,
    };
};

const runInput = (stage: ReturnType<typeof makeStage>, context: ReturnType<typeof buildContext>) => ({
    stage,
    context,
    planPath: '/run/plan.md',
    title: 'a card',
    resultSchema,
});

describe('CliStageAgent request_scope tool', () => {
    afterEach(() => {
        queryMock.mockReset();
        toolMock.mockClear();
        tools.clear();
    });

    it('registers request_scope as a second tool on the wilson MCP server, alongside report_result', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage(), buildContext()) as never);

        expect(tools.has('request_scope')).toBe(true);
        expect(tools.has('report_result')).toBe(true);
    });

    it('grants the requested path under the widen policy, and the message the model sees says so', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);
        const context = buildContext('widen');

        await agent.run(runInput(makeStage(), context) as never);
        const handler = tools.get('request_scope')!;
        const result = (await handler({ path: 'src/other/thing.ts', reason: 'plan omitted it' })) as {
            content: { type: string; text: string }[];
        };

        expect(result.content[0]?.text).toContain('granted');
        // The grant took effect on this context's own scope guard, not just in the returned text.
        await expect(context.scope.check('src/other/thing.ts')).resolves.toMatchObject({ allowed: true });
    });

    it('throws ScopeKickbackError under the kickback policy, same as the api adapter’s tool', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);
        const context = buildContext('kickback');

        await agent.run(runInput(makeStage(), context) as never);
        const handler = tools.get('request_scope')!;

        await expect(handler({ path: 'src/other/thing.ts', reason: 'plan omitted it' })).rejects.toBeInstanceOf(ScopeKickbackError);
    });

    it('names the qualified request_scope tool in the prompt sent to the engine', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage(), buildContext()) as never);

        const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
        expect(call.prompt).toContain('mcp__wilson__request_scope');
    });

    // The review on this card caught request_scope registered unconditionally: a readonly or none
    // stage could call it, log scope.requested/granted, or even trip ScopeKickbackError under the
    // kickback policy for a widening it could never use, since it can never write in the first
    // place. The fix gates the tool — and the prompt line naming it — on stage.worktree === 'rw',
    // the same condition the api adapter's buildTools uses. These two cases are what that fix does.
    it.each(['readonly', 'none'] as const)(
        'does not register request_scope on the MCP server for a %s stage, though report_result is still there',
        async worktree => {
            queryMock.mockReturnValue(streamOf([]));
            const agent = new CliStageAgent(silentLogger as never);

            await agent.run(runInput(makeStage({ worktree }), buildContext()) as never);

            expect(tools.has('request_scope')).toBe(false);
            expect(tools.has('report_result')).toBe(true);
        },
    );

    it.each(['readonly', 'none'] as const)('does not name request_scope in the prompt for a %s stage', async worktree => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage({ worktree }), buildContext()) as never);

        const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
        expect(call.prompt).not.toContain('mcp__wilson__request_scope');
    });
});

describe('createToolGuard and request_scope', () => {
    const opts = { signal: new AbortController().signal } as never;

    it('allows the adapter’s own MCP request_scope tool unconditionally, the same way it allows report_result', async () => {
        const context = buildContext('widen');
        const guard = createToolGuard(context as never, 'rw');

        await expect(guard('mcp__wilson__request_scope', { path: 'src/other/thing.ts', reason: 'why' }, opts)).resolves.toMatchObject({
            behavior: 'allow',
        });
    });

    it('still denies request_scope-shaped calls from any other MCP server', async () => {
        const context = buildContext('widen');
        const guard = createToolGuard(context as never, 'rw');

        await expect(guard('mcp__elsewhere__request_scope', { path: 'x', reason: 'y' }, opts)).resolves.toMatchObject({ behavior: 'deny' });
    });

    it.each(['readonly', 'none'] as const)(
        'denies the adapter’s own request_scope tool for a %s stage, the same reason it denies a write',
        async writable => {
            const context = buildContext('widen');
            const guard = createToolGuard(context as never, writable);

            const decision = await guard('mcp__wilson__request_scope', { path: 'src/other/thing.ts', reason: 'why' }, opts);

            expect(decision).toMatchObject({ behavior: 'deny', message: `this stage is ${writable}: it may not write` });
        },
    );
});
