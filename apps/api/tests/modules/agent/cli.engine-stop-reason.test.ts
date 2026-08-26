import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0118. A stage that ends without calling `report_result` used to fail with no record of
 * *why* the engine stopped — the model finishing its turn, the stream closing, a wall-clock/idle
 * timeout firing, and an engine process dying all collapsed into the same bare "never reported
 * finishing" message. `CliStageAgent.run` now reads the SDK's own `result` message — its `subtype`
 * and, when set, its `stop_reason` — through `describeEngineStop`, and carries that as
 * `AgentRunOutput.engineStopReason` wherever the SDK actually said something.
 *
 * These tests exercise every place that field can be set or, just as importantly, left unset:
 * a `result` message is the SDK's only source for it, so a run that never sees one (a runner
 * timeout, or the stream simply closing) must not fabricate a reason (card 0118: "a confident
 * wrong reason is worse than none").
 *
 * `query` is mocked the same way `cli.result-dropped.test.ts` does: the mocked
 * `createSdkMcpServer`/`tool` never wire the handler up to anything, so a bare `streamOf` run never
 * actually calls `report_result` even when a `tool_use` block for it appears on the stream. To get
 * a genuinely reported result (and so exercise the "ordinary pass" case where `engineStopReason`
 * must stay unset), the report file itself is written to disk and the handler invoked directly,
 * matching `cli.report.result.test.ts`'s `streamCallingReport` helper.
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
    const root = await mkdtemp(join(tmpdir(), 'cli-engine-stop-reason-'));
    await mkdir(join(root, 'src'), { recursive: true });
    return root;
};

const runInput = (stage: ReturnType<typeof makeStage>, worktreeRoot: string) => ({
    stage,
    context: {
        project: 'p',
        cardId: '1',
        stage: 's',
        worktreeRoot,
        scope: new ScopeGuard({ worktreeRoot, allow: ['src/**'], alwaysAllowed: [] }),
        commands: new CommandAllowlist(['pnpm build']),
        scopeViolationPolicy: 'widen' as const,
        events: { append: async () => {} },
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
    message: { content: [{ type: 'text', text: 'still working on it' }] },
};

type Output = { result?: unknown; truncated: boolean; engineStopReason?: string; budgetFailure?: string };

describe('CliStageAgent — engineStopReason (card 0118)', () => {
    afterEach(() => {
        queryMock.mockReset();
        toolMock.mockClear();
        tools.clear();
    });

    it('names the SDK subtype and stop_reason when a clean turn ends without ever calling report_result', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(
            streamOf([proseOnlyMessage, { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }]),
        );
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage(), root) as never)) as Output;

        expect(output.result).toBeUndefined();
        expect(output.engineStopReason).toBe("ended as 'success' (stop_reason: end_turn)");
    });

    it('leaves engineStopReason unset on an ordinary pass, where the result actually arrived', async () => {
        const root = await makeWorktree();
        await writeFile(join(root, REPORT_RESULT_PATH), JSON.stringify({ summary: 'did the thing' }), 'utf8');
        queryMock.mockReturnValue({
            [Symbol.asyncIterator]() {
                let step = 0;
                return {
                    async next() {
                        if (step === 0) {
                            step = 1;
                            await tools.get('report_result')!({});
                            return { done: false, value: { type: 'assistant', message: { content: [] } } };
                        }
                        return {
                            done: false,
                            value: { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
                        };
                    },
                };
            },
        });
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage(), root) as never)) as Output;

        expect(output.result).toEqual({ summary: 'did the thing' });
        expect(output.engineStopReason).toBeUndefined();
    });

    it('names a non-success subtype even without a stop_reason, on the truncated path', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(
            streamOf([proseOnlyMessage, { type: 'result', subtype: 'error_max_turns', stop_reason: null, usage: { input_tokens: 10, output_tokens: 5 } }]),
        );
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage(), root) as never)) as Output;

        expect(output.truncated).toBe(true);
        expect(output.engineStopReason).toBe("ended as 'error_max_turns'");
    });

    it('carries a non-success reason on the truncated path even when the report tool was seen', async () => {
        // A run that also called report_result but still ran out of turns: the SDK's own reason is
        // still worth recording, unlike the success path where a reported result means nothing went
        // wrong worth naming.
        const root = await makeWorktree();
        queryMock.mockReturnValue(
            streamOf([
                { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__wilson__report_result', id: 'toolu_1', input: {} }] } },
                { type: 'result', subtype: 'error_max_turns', stop_reason: null, usage: { input_tokens: 10, output_tokens: 5 } },
            ]),
        );
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage(), root) as never)) as Output;

        expect(output.engineStopReason).toBe("ended as 'error_max_turns'");
    });

    it('leaves engineStopReason unset when the runner’s own wall-clock timeout fires before any result message arrives', async () => {
        const root = await makeWorktree();
        queryMock.mockImplementation(({ options }: { options: { abortController: AbortController } }) => ({
            [Symbol.asyncIterator]() {
                return {
                    next: () =>
                        new Promise((_resolve, reject) => {
                            options.abortController.signal.addEventListener('abort', () => {
                                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                            });
                        }),
                };
            },
        }));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage({ maxWallClockMs: 20 }), root) as never)) as Output;

        expect(output.truncated).toBe(true);
        expect(output.engineStopReason).toBeUndefined();
    }, 10_000);

    it('leaves engineStopReason unset when the stream simply closes with no result message ever seen', async () => {
        const root = await makeWorktree();
        // No `result` message at all — the loop ends via `next.done`, the fallthrough path at the
        // bottom of `run()`, not any of the branches that read a `result` message.
        queryMock.mockReturnValue(streamOf([proseOnlyMessage]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage(), root) as never)) as Output;

        expect(output.result).toBeUndefined();
        expect(output.truncated).toBe(false);
        expect(output.engineStopReason).toBeUndefined();
    });
});
