import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0126. Fifteen prior instances (cards 0010 through 0117) share one shape: a stage ends its
 * turn having called no tool at all, not even its own `report_result`, and the runner only found
 * out afterwards — from an empty diff and a missing report — with no record of what actually
 * happened. Card 0118 gave the first of those a name (`engineStopReason: "ended as 'success'
 * (stop_reason: end_turn)"`), but that same text is also what a run gets when it wrote files, ran
 * the build, and simply forgot the final report call — a different, unobserved failure this card
 * is deliberately not building for (its "one reason so far" constraint).
 *
 * `CliStageAgent.run` now tracks whether *any* tool_use block appeared anywhere in the run
 * (`anyToolSeen`), not just the report tool, and appends a `turn.empty` event the moment a clean
 * (`subtype: 'success'`) turn ends with that flag still false and nothing reported — detected from
 * inside the run itself, not reconstructed afterwards. The exit condition is unchanged: the stage
 * still fails exactly as it did before (no `result`, `engineStopReason` still set), this only adds
 * the event.
 *
 * `query` is mocked the same way `cli.engine-stop-reason.test.ts` does: a bare stream never wires
 * `report_result`'s handler up to anything, so a genuinely reported result needs the report file
 * written to disk and the handler invoked directly.
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

const { CliStageAgent } = await import('#modules/agent/cli.stage.agent.js');
const { REPORT_RESULT_PATH, ScopeGuard } = await import('#modules/agent/scope.guard.js');
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
    const root = await mkdtemp(join(tmpdir(), 'cli-empty-turn-'));
    await mkdir(join(root, 'src'), { recursive: true });
    return root;
};

const runInput = (stage: ReturnType<typeof makeStage>, worktreeRoot: string, events: { append: (event: unknown) => Promise<void> }) => ({
    stage,
    context: {
        project: 'p',
        cardId: '1',
        stage: 's',
        worktreeRoot,
        scope: new ScopeGuard({ worktreeRoot, allow: ['src/**'], alwaysAllowed: [] }),
        commands: new CommandAllowlist(['pnpm build']),
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

const proseOnlyMessage = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'looks like there is nothing to do here' }] },
};

const successResult = { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };

type Output = { result?: unknown; truncated: boolean; engineStopReason?: string };
type RecordedEvent = { type: string; payload?: Record<string, unknown> };

const recordingEvents = (): { events: { append: (event: RecordedEvent) => Promise<void> }; recorded: RecordedEvent[] } => {
    const recorded: RecordedEvent[] = [];
    return { events: { append: async (event: RecordedEvent) => void recorded.push(event) }, recorded };
};

describe('CliStageAgent — turn.empty (card 0126)', () => {
    afterEach(() => {
        queryMock.mockReset();
        toolMock.mockClear();
        tools.clear();
    });

    it('records turn.empty when a clean turn ends with no tool call at all and nothing reported', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(streamOf([proseOnlyMessage, successResult]));
        const { events, recorded } = recordingEvents();
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage(), root, events) as never)) as Output;

        expect(output.result).toBeUndefined();
        expect(output.engineStopReason).toBe("ended as 'success' (stop_reason: end_turn)");
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({ type: 'turn.empty', payload: { engineStopReason: "ended as 'success' (stop_reason: end_turn)" } });
    });

    it('does not record turn.empty on a run that never produced even one assistant message', async () => {
        const root = await makeWorktree();
        // No assistant message at all before the result — the same "nothing happened" shape as the
        // prose-only case above, reached a different way.
        queryMock.mockReturnValue(streamOf([successResult]));
        const { events, recorded } = recordingEvents();
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage(), root, events) as never);

        expect(recorded).toHaveLength(1);
        expect(recorded[0]?.type).toBe('turn.empty');
    });

    it('does not record turn.empty when a tool ran but the stage merely forgot to report', async () => {
        // A genuinely different, unobserved shape this card is not building for (its "one reason so
        // far" constraint): the engine did something — a Write here — and only the final report call
        // is missing. `anyToolSeen` must stay true so this is left to the existing, unnamed failure
        // path rather than folded into `turn.empty`.
        const root = await makeWorktree();
        const wroteAFile = {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'Write', id: 'toolu_1', input: { file_path: 'src/x.ts', content: 'x' } }] },
        };
        queryMock.mockReturnValue(streamOf([wroteAFile, successResult]));
        const { events, recorded } = recordingEvents();
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage(), root, events) as never)) as Output;

        expect(output.result).toBeUndefined();
        expect(recorded).toHaveLength(0);
    });

    it('does not fire on a stage that legitimately has nothing to do and reports so honestly', async () => {
        // The constraint this card is most careful about: a stage that finds its work already done
        // and reports an honest, empty-diff result must not be mistaken for one that never started.
        // It still calls report_result — `reported` ends up defined — so the new check, which only
        // fires while `reported` is undefined, must not touch it.
        const root = await makeWorktree();
        await writeFile(join(root, REPORT_RESULT_PATH), JSON.stringify({ summary: 'nothing to do; already committed' }), 'utf8');
        queryMock.mockReturnValue({
            [Symbol.asyncIterator]() {
                let step = 0;
                return {
                    async next() {
                        if (step === 0) {
                            step = 1;
                            await tools.get('report_result')!({});
                            return {
                                done: false,
                                value: {
                                    type: 'assistant',
                                    message: { content: [{ type: 'tool_use', name: 'mcp__wilson__report_result', id: 'toolu_1', input: {} }] },
                                },
                            };
                        }
                        return { done: false, value: successResult };
                    },
                };
            },
        });
        const { events, recorded } = recordingEvents();
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage(), root, events) as never)) as Output;

        expect(output.result).toEqual({ summary: 'nothing to do; already committed' });
        expect(output.engineStopReason).toBeUndefined();
        expect(recorded).toHaveLength(0);
    });
});
