import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0254. Card 0249 registered `createToolGuard`'s decision as a `PreToolUse` hook on `query()`,
 * but left `canUseTool` wired to the identical guard instance as a backstop for any call that still
 * reached it. Nine live diagnostic runs on 2026-09-19, against host engine 2.1.278, found that
 * *registering* `canUseTool` is itself the cause of the gap it was meant to catch: with a
 * `canUseTool` callback registered (identical guard, hook and all), the engine settled the
 * denied-bash engine probe's call as safe itself, skipping both the callback and the hook, and the
 * command ran unguarded (`tool.unguarded`). Removing `canUseTool` from `query()`'s options made the
 * hook fire for that same call and refuse it.
 *
 * So this card removes `canUseTool` from `query()`'s options entirely — see `cli.stage.agent.ts`'s
 * class doc comment for the full finding. `cli.tool.guard.hook.test.ts` and
 * `cli.pretooluse.hook.test.ts` already prove the hook's own mapping and the guard's per-id dedup in
 * the abstract; what neither of those (nor `cli.tool.unguarded.test.ts`, prior to this card's own
 * updates to it) ever checked is the literal shape of the `query()` call this card changes: that
 * `canUseTool` is not merely unused but genuinely absent from the options object, so nothing about
 * this adapter can ever again depend on the engine choosing to call it. A test that only checked
 * `options.canUseTool` was falsy would have passed before this card too, since `canUseTool` was
 * never invoked by any of these mocks either way — checking the property's presence is what actually
 * pins the change.
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
    const root = await mkdtemp(join(tmpdir(), 'cli-canusetool-removed-'));
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
        cardId: '0254',
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

const streamOf = (messages: unknown[]) => ({
    async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
    },
});

type PreToolUseHook = (input: unknown, toolUseID: string | undefined, opts: { signal: AbortSignal }) => Promise<unknown>;
type MockOptions = {
    hooks?: { PreToolUse?: [{ hooks: PreToolUseHook[] }] };
    canUseTool?: (n: string, i: unknown, o: unknown) => Promise<unknown>;
};

const hookInput = (toolName: string, input: Record<string, unknown>, toolUseId: string) =>
    ({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: input, tool_use_id: toolUseId }) as never;

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

describe('CliStageAgent — canUseTool removed, PreToolUse the only permission path (card 0254)', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    it('AC1: calls query() with no canUseTool property on options at all, not merely an unused one', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(streamOf([successResult]));
        const { events } = recordingEvents();

        await new CliStageAgent(silentLogger as never).run(runInput(makeStage(), root, events) as never);

        const options = (queryMock.mock.calls[0]?.[0] as { options: MockOptions }).options;
        // Before this card, `canUseTool: toolGuard` was set here — a function, so
        // `options.canUseTool` was truthy. Checking presence (not just truthiness) is what proves the
        // key itself is gone, since a mock stream that never calls `options.canUseTool` at all cannot
        // otherwise distinguish "removed" from "registered but never reached".
        expect(options).not.toHaveProperty('canUseTool');
    });

    it('AC3: an allowed Bash call reaching the engine only through the hook gets permissionDecision "allow" and is recorded exactly once as tool.executed', async () => {
        const root = await makeWorktree();
        let hookResult: unknown;
        queryMock.mockReturnValue({
            async *[Symbol.asyncIterator]() {
                const options = (queryMock.mock.calls[0]?.[0] as { options: MockOptions }).options;
                const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
                if (!hook) throw new Error('no PreToolUse hook registered');
                hookResult = await hook(hookInput('Bash', { command: 'true' }, 'toolu_1'), 'toolu_1', { signal: new AbortController().signal });
                yield bashToolUse('toolu_1', 'true');
                yield toolResult('toolu_1');
                yield successResult;
            },
        });
        const { events, recorded } = recordingEvents();

        await new CliStageAgent(silentLogger as never).run(runInput(makeStage(), root, events) as never);

        expect(hookResult).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
        expect(recorded.filter(e => e.type === 'tool.executed')).toMatchObject([{ type: 'tool.executed', payload: { tool: 'Bash', command: 'true' } }]);
    });

    it('AC2: a Bash command outside the stage’s allowlist is refused through the hook and recorded exactly once as tool.denied — the step-credit half of this AC is `cli.step.budget.test.ts`, updated by this card to drive the same hook-only path', async () => {
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

        expect(recorded.filter(e => e.type === 'tool.denied')).toHaveLength(1);
        expect(recorded.filter(e => e.type === 'tool.executed')).toHaveLength(0);
    });
});
