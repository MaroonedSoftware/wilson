import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0248. `CliStageAgent` enforces scope and the command allowlist entirely inside
 * `createToolGuard` (`canUseTool`), but nothing previously checked that the engine actually asked
 * it. On 2026-09-19, against host engine 2.1.266, a diagnostic run made one Bash call with a
 * `canUseTool` that refused everything, and the guard was never called at all: the command ran, and
 * no `tool.denied` or `tool.executed` landed for it.
 *
 * `CliStageAgent.run` now collects, by `tool_use` id, every guarded (Write/Edit/Bash) call the
 * engine proposed, every id `canUseTool` was actually asked about, and every id that reached a
 * `tool_result` in a later `user` message. In its `finally` block it appends one `tool.unguarded`
 * event for each id that completed (has a `tool_result`) without ever being consulted.
 *
 * `query` is mocked the same way `cli.empty.turn.test.ts` does: a plain array-backed stream, with
 * the guard reached — when a test needs to simulate a real consultation — via the registered
 * `PreToolUse` hook off the `options` object `query()` was actually called with, exactly as
 * `cli.step.budget.test.ts` and `cli.pretooluse.hook.test.ts` reach it for their own simulations.
 * Card 0254 removed `canUseTool` from `query()`'s options entirely, so the hook is the only door
 * left; before that card this test drove `options.canUseTool` directly.
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
    const root = await mkdtemp(join(tmpdir(), 'cli-tool-unguarded-'));
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
        cardId: '0248',
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

/** A plain array-backed stream, mirroring `cli.empty.turn.test.ts`'s `streamOf`. */
const streamOf = (messages: unknown[]) => ({
    async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
    },
});

type PreToolUseHook = (input: unknown, toolUseID: string | undefined, opts: { signal: AbortSignal }) => Promise<unknown>;

const hookInput = (toolName: string, input: Record<string, unknown>, toolUseId: string) =>
    ({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: input, tool_use_id: toolUseId }) as never;

/**
 * The same stream, but before yielding `messages` it drives the registered `PreToolUse` hook itself
 * — reached off the real `options` object `query()` was invoked with, the same way
 * `cli.step.budget.test.ts` and `cli.pretooluse.hook.test.ts` reach it to simulate a consultation.
 * Card 0254 removed `canUseTool` from `query()`'s options entirely, so the hook is the only door
 * left to drive this through. This is what "the guard was actually consulted for this id" looks
 * like from the engine's side now.
 */
const streamConsultingThen = (consult: { toolName: string; input: Record<string, unknown>; toolUseID: string }, messages: unknown[]) => ({
    async *[Symbol.asyncIterator]() {
        const options = (queryMock.mock.calls[0]?.[0] as { options: { hooks?: { PreToolUse?: [{ hooks: PreToolUseHook[] }] } } }).options;
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

const writeToolUse = (id: string, filePath: string) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Write', id, input: { file_path: filePath, content: 'x' } }] },
});

const readToolUse = (id: string, filePath: string) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', id, input: { file_path: filePath } }] },
});

const toolResult = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

const successResult = { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
const truncatedResult = { type: 'result', subtype: 'error_max_turns', usage: { input_tokens: 10, output_tokens: 5 } };

const unguarded = (recorded: RecordedEvent[]): RecordedEvent[] => recorded.filter(e => e.type === 'tool.unguarded');

describe('CliStageAgent — tool.unguarded (card 0248)', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    it('appends tool.unguarded for a Bash call that completed without canUseTool ever being consulted for its id', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(streamOf([bashToolUse('toolu_1', 'true'), toolResult('toolu_1'), successResult]));
        const { events, recorded } = recordingEvents();

        await new CliStageAgent(silentLogger as never).run(runInput(makeStage(), root, events) as never);

        expect(unguarded(recorded)).toMatchObject([{ type: 'tool.unguarded', payload: { tool: 'Bash', command: 'true' } }]);
    });

    it('carries the path, not a command, for an unconsulted Write call', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(streamOf([writeToolUse('toolu_1', 'src/x.ts'), toolResult('toolu_1'), successResult]));
        const { events, recorded } = recordingEvents();

        await new CliStageAgent(silentLogger as never).run(runInput(makeStage(), root, events) as never);

        expect(unguarded(recorded)).toMatchObject([{ type: 'tool.unguarded', payload: { tool: 'Write', path: 'src/x.ts' } }]);
    });

    it('does not append tool.unguarded when the hook was consulted and allowed the call', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(
            streamConsultingThen({ toolName: 'Bash', input: { command: 'true' }, toolUseID: 'toolu_1' }, [
                bashToolUse('toolu_1', 'true'),
                toolResult('toolu_1'),
                successResult,
            ]),
        );
        const { events, recorded } = recordingEvents();

        await new CliStageAgent(silentLogger as never).run(runInput(makeStage(), root, events) as never);

        expect(unguarded(recorded)).toHaveLength(0);
    });

    it('does not append tool.unguarded when the hook was consulted and denied the call', async () => {
        const root = await makeWorktree();
        // Not in the ['true'] allowlist, so this consultation ends in a denial rather than an allow —
        // AC2 covers both outcomes, since a skipped consultation is the gap, not the verdict.
        queryMock.mockReturnValue(
            streamConsultingThen({ toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseID: 'toolu_1' }, [
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

    it('does not append tool.unguarded for a tool_use with no matching tool_result — a run cut off mid-call', async () => {
        const root = await makeWorktree();
        // No `toolResult('toolu_1')` here at all: the call never completed before the run ended, so
        // it must not be reported as unguarded even though canUseTool was never asked about it either.
        queryMock.mockReturnValue(streamOf([bashToolUse('toolu_1', 'true'), successResult]));
        const { events, recorded } = recordingEvents();

        await new CliStageAgent(silentLogger as never).run(runInput(makeStage(), root, events) as never);

        expect(unguarded(recorded)).toHaveLength(0);
    });

    it('never reports tool.unguarded for tools other than Write, Edit and Bash', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(streamOf([readToolUse('toolu_1', 'src/x.ts'), toolResult('toolu_1'), successResult]));
        const { events, recorded } = recordingEvents();

        await new CliStageAgent(silentLogger as never).run(runInput(makeStage(), root, events) as never);

        expect(unguarded(recorded)).toHaveLength(0);
    });

    it('still detects the unguarded call when the run ends truncated rather than cleanly', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(streamOf([bashToolUse('toolu_1', 'true'), toolResult('toolu_1'), truncatedResult]));
        const { events, recorded } = recordingEvents();

        const output = (await new CliStageAgent(silentLogger as never).run(runInput(makeStage(), root, events) as never)) as {
            truncated: boolean;
        };

        expect(output.truncated).toBe(true);
        expect(unguarded(recorded)).toMatchObject([{ type: 'tool.unguarded', payload: { tool: 'Bash', command: 'true' } }]);
    });
});
