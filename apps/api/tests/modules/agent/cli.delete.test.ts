import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0086 gave the `cli` adapter a `delete` tool, wired the same way card 0021 wired
 * `request_scope`: a third tool on the `wilson` in-process MCP server, sharing `deleteFile` with the
 * `api` adapter's `delete` tool so the two cannot drift, gated on `stage.worktree === 'rw'`, and
 * allowed through `createToolGuard` only for a writable stage.
 *
 * `query` is mocked and `tool()` calls are captured by name rather than driven against a real engine,
 * matching `cli.request.scope.test.ts`'s own reasoning: what is under test is what this adapter wires
 * up and does with what comes back, not the engine's own judgement.
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
const { z } = await import('zod');
const { mkdtemp, mkdir, writeFile, stat } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

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

const buildContext = (worktreeRoot: string) => {
    const events: { type: string; payload?: Record<string, unknown> }[] = [];
    return {
        project: 'p',
        cardId: '1',
        stage: 's',
        worktreeRoot,
        scope: new ScopeGuard({ worktreeRoot, allow: ['src/runner/**'], alwaysAllowed: [] }),
        commands: new CommandAllowlist(['pnpm build']),
        scopeViolationPolicy: 'widen' as const,
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

describe('CliStageAgent delete tool', () => {
    afterEach(() => {
        queryMock.mockReset();
        toolMock.mockClear();
        tools.clear();
    });

    it('registers delete as a third tool on the wilson MCP server, alongside report_result and request_scope', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);
        const base = await mkdtemp(join(tmpdir(), 'cli-delete-'));

        await agent.run(runInput(makeStage(), buildContext(base)) as never);

        expect(tools.has('delete')).toBe(true);
        expect(tools.has('request_scope')).toBe(true);
        expect(tools.has('report_result')).toBe(true);
    });

    it('deletes a real file inside scope when the registered handler is invoked, the same as the delete.tool.ts function', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);
        const base = await mkdtemp(join(tmpdir(), 'cli-delete-'));
        await mkdir(join(base, 'src', 'runner'), { recursive: true });
        await writeFile(join(base, 'src', 'runner', 'gone.ts'), 'x', 'utf8');
        const context = buildContext(base);

        await agent.run(runInput(makeStage(), context) as never);
        const handler = tools.get('delete')!;
        const result = (await handler({ path: 'src/runner/gone.ts' })) as { content: { type: string; text: string }[] };

        expect(result.content[0]?.text).toContain('deleted');
        await expect(stat(join(base, 'src', 'runner', 'gone.ts'))).rejects.toThrow();
    });

    it('refuses to delete a path outside scope through the registered handler, and leaves the file in place', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);
        const base = await mkdtemp(join(tmpdir(), 'cli-delete-'));
        await mkdir(join(base, 'src', 'other'), { recursive: true });
        await writeFile(join(base, 'src', 'other', 'keep.ts'), 'x', 'utf8');
        const context = buildContext(base);

        await agent.run(runInput(makeStage(), context) as never);
        const handler = tools.get('delete')!;
        const result = (await handler({ path: 'src/other/keep.ts' })) as { content: { type: string; text: string }[] };

        expect(result.content[0]?.text).toContain('error');
        await expect(stat(join(base, 'src', 'other', 'keep.ts'))).resolves.toBeDefined();
    });

    it('names the qualified delete tool in the prompt sent to the engine', async () => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);
        const base = await mkdtemp(join(tmpdir(), 'cli-delete-'));

        await agent.run(runInput(makeStage(), buildContext(base)) as never);

        const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
        expect(call.prompt).toContain('mcp__wilson__delete');
    });

    // Mirrors the fix card 0086's review of request_scope's own registration bug would apply here:
    // a readonly or none stage can never write, so it must not be handed a delete tool either.
    it.each(['readonly', 'none'] as const)(
        'does not register delete on the MCP server for a %s stage, though report_result is still there',
        async worktree => {
            queryMock.mockReturnValue(streamOf([]));
            const agent = new CliStageAgent(silentLogger as never);
            const base = await mkdtemp(join(tmpdir(), 'cli-delete-'));

            await agent.run(runInput(makeStage({ worktree }), buildContext(base)) as never);

            expect(tools.has('delete')).toBe(false);
            expect(tools.has('report_result')).toBe(true);
        },
    );

    it.each(['readonly', 'none'] as const)('does not name delete in the prompt for a %s stage', async worktree => {
        queryMock.mockReturnValue(streamOf([]));
        const agent = new CliStageAgent(silentLogger as never);
        const base = await mkdtemp(join(tmpdir(), 'cli-delete-'));

        await agent.run(runInput(makeStage({ worktree }), buildContext(base)) as never);

        const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
        expect(call.prompt).not.toContain('mcp__wilson__delete');
    });
});

describe('createToolGuard and delete', () => {
    const opts = { signal: new AbortController().signal } as never;

    it('allows the adapter’s own MCP delete tool unconditionally, the same way it allows request_scope', async () => {
        const context = buildContext('/tmp');
        const guard = createToolGuard(context as never, 'rw');

        await expect(guard('mcp__wilson__delete', { path: 'src/runner/thing.ts' }, opts)).resolves.toMatchObject({ behavior: 'allow' });
    });

    it('still denies delete-shaped calls from any other MCP server', async () => {
        const context = buildContext('/tmp');
        const guard = createToolGuard(context as never, 'rw');

        await expect(guard('mcp__elsewhere__delete', { path: 'x' }, opts)).resolves.toMatchObject({ behavior: 'deny' });
    });

    it.each(['readonly', 'none'] as const)(
        'denies the adapter’s own delete tool for a %s stage, the same reason it denies a write',
        async writable => {
            const context = buildContext('/tmp');
            const guard = createToolGuard(context as never, writable);

            const decision = await guard('mcp__wilson__delete', { path: 'src/runner/thing.ts' }, opts);

            expect(decision).toMatchObject({ behavior: 'deny', message: `this stage is ${writable}: it may not write` });
        },
    );
});
