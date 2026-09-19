import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0249. `CliStageAgent` now registers the guard as a `PreToolUse` hook on `query()`, with
 * `canUseTool` left wired to the same guard instance as a backstop — see `cli.stage.agent.ts`'s
 * class doc comment for why: a 2026-09-19 diagnostic run found host engine 2.1.266 sometimes never
 * calls `canUseTool` at all, but does call the hook unconditionally.
 *
 * `cli.tool.unguarded.test.ts` (card 0248) only ever drives the call through `canUseTool`, so it
 * cannot show that a call consulted solely through the hook is recognised as guarded (AC5), or that
 * `query()` is actually wired up with the hook in the first place (AC6). This file drives the same
 * mocked-`query()` harness `cli.tool.unguarded.test.ts` and `cli.step.budget.test.ts` both use, but
 * reaches `options.hooks.PreToolUse[0].hooks[0]` — the callback `toolGuardHook` produced — instead
 * of `options.canUseTool`.
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
const { ScopeGuard } = await import('#modules/agent/scope.guard.js');
const { CommandAllowlist } = await import('#modules/agent/command.allowlist.js');
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

const makeWorktree = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'cli-pretooluse-hook-'));
    await mkdir(join(root, 'src'), { recursive: true });
    return root;
};

type RecordedEvent = { type: string; payload?: Record<string, unknown> };

const recordingEvents = (): { events: { append: (event: RecordedEvent) => Promise<void> }; recorded: RecordedEvent[] } => {
    const recorded: RecordedEvent[] = [];
    return { events: { append: async (event: RecordedEvent) => void recorded.push(event) }, recorded };
};

const runInput = (stage: ReturnType<typeof makeStage>, worktreeRoot: string, events: { append: (event: RecordedEvent) => Promise<void> }) => ({
    stage,
    context: {
        project: 'p',
        cardId: '0249',
        stage: 's',
        worktreeRoot,
        scope: new ScopeGuard({ worktreeRoot, allow: ['src/**'], alwaysAllowed: [] }),
        commands: new CommandAllowlist(['true']),
        scopeViolationPolicy: 'widen' as const,
        events,
        logger: silentLogger,
    },
    planPath: '/run/plan.md',
    title: 'a card',
    resultSchema: z.object({ summary: z.string().optional() }),
});

/** A plain array-backed stream, mirroring `cli.empty.turn.test.ts` and `cli.tool.unguarded.test.ts`. */
const streamOf = (messages: unknown[]) => ({
    async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
    },
});

type PreToolUseHook = (input: unknown, toolUseID: string | undefined, opts: { signal: AbortSignal }) => Promise<unknown>;
type MockOptions = {
    hooks?: { PreToolUse?: [{ hooks: PreToolUseHook[] }] };
    canUseTool: (n: string, i: unknown, o: unknown) => Promise<unknown>;
    allowedTools?: unknown;
};

const hookInput = (toolName: string, input: Record<string, unknown>, toolUseId: string) =>
    ({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: input, tool_use_id: toolUseId }) as never;

/**
 * The same shape `cli.tool.unguarded.test.ts`'s `streamConsultingThen` uses, but reaching the
 * engine's *other* door: `options.hooks.PreToolUse[0].hooks[0]`, the callback `toolGuardHook`
 * produced, rather than `options.canUseTool`. This is what "the guard was consulted, but only
 * through the hook" looks like from the engine's side — exactly the gap `canUseTool`-only coverage
 * cannot exercise.
 */
const streamConsultingViaHookThen = (consult: { toolName: string; input: Record<string, unknown>; toolUseID: string }, messages: unknown[]) => ({
    async *[Symbol.asyncIterator]() {
        const options = (queryMock.mock.calls[0]?.[0] as { options: MockOptions }).options;
        const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
        if (!hook) throw new Error('no PreToolUse hook registered');
        await hook(hookInput(consult.toolName, consult.input, consult.toolUseID), consult.toolUseID, { signal: new AbortController().signal });
        for (const message of messages) yield message;
    },
});

const bashToolUse = (id: string, command: string) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] },
});

const toolResult = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

const successResult = { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };

const unguarded = (recorded: RecordedEvent[]): RecordedEvent[] => recorded.filter(e => e.type === 'tool.unguarded');

describe('CliStageAgent — PreToolUse hook (card 0249)', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    it('AC6: calls query() with a PreToolUse hook registered, and without allowedTools set', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(streamOf([successResult]));
        const { events } = recordingEvents();

        await new CliStageAgent(silentLogger as never).run(runInput(makeStage(), root, events) as never);

        const options = (queryMock.mock.calls[0]?.[0] as { options: MockOptions }).options;
        expect(options.allowedTools).toBeUndefined();
        expect(typeof options.hooks?.PreToolUse?.[0]?.hooks?.[0]).toBe('function');
    });

    it('AC5: does not append tool.unguarded for an allowed Bash call consulted only through the hook', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(
            streamConsultingViaHookThen({ toolName: 'Bash', input: { command: 'true' }, toolUseID: 'toolu_1' }, [
                bashToolUse('toolu_1', 'true'),
                toolResult('toolu_1'),
                successResult,
            ]),
        );
        const { events, recorded } = recordingEvents();

        await new CliStageAgent(silentLogger as never).run(runInput(makeStage(), root, events) as never);

        expect(unguarded(recorded)).toHaveLength(0);
    });

    it('AC5: does not append tool.unguarded for a denied Bash call consulted only through the hook', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(
            streamConsultingViaHookThen({ toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseID: 'toolu_1' }, [
                bashToolUse('toolu_1', 'rm -rf /'),
                toolResult('toolu_1'),
                successResult,
            ]),
        );
        const { events, recorded } = recordingEvents();

        await new CliStageAgent(silentLogger as never).run(runInput(makeStage(), root, events) as never);

        expect(recorded.some(e => e.type === 'tool.denied')).toBe(true);
        expect(unguarded(recorded)).toHaveLength(0);
    });

    it('AC4: consulting the same toolUseID through the hook and then through the canUseTool backstop records the denial once', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue({
            async *[Symbol.asyncIterator]() {
                const options = (queryMock.mock.calls[0]?.[0] as { options: MockOptions }).options;
                const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
                if (!hook) throw new Error('no PreToolUse hook registered');
                await hook(hookInput('Bash', { command: 'rm -rf /' }, 'toolu_1'), 'toolu_1', { signal: new AbortController().signal });
                // The backstop the engine falls back to when it does consult canUseTool too — same
                // toolUseID, same call, the other door.
                await options.canUseTool('Bash', { command: 'rm -rf /' }, { toolUseID: 'toolu_1' });
                yield bashToolUse('toolu_1', 'rm -rf /');
                yield toolResult('toolu_1');
                yield successResult;
            },
        });
        const { events, recorded } = recordingEvents();

        await new CliStageAgent(silentLogger as never).run(runInput(makeStage(), root, events) as never);

        expect(recorded.filter(e => e.type === 'tool.denied')).toHaveLength(1);
    });
});
