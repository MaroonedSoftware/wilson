import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0073: `report_result` used to carry this stage's whole result as its tool arguments —
 * `(resultSchema as z.ZodObject).shape` — which crosses the SDK's in-process MCP transport as
 * arguments on the tool call itself. Two documented SDK failure modes land on exactly that: large
 * arguments (sdk#41) and nested schemas (sdk#277/sdk#105), both of which leave `reported` undefined
 * for reasons no re-implementing can fix.
 *
 * The fix has the tool carry only a worktree-relative path. The model writes its finished result to
 * that file; the adapter reads it, validates it against `resultSchema` itself, and unlinks it in
 * `finally` so it never reaches a diff. These tests exercise that file round trip directly — the
 * real filesystem and the real `ScopeGuard`, not a mock of either — because the whole point of the
 * change is what crosses the tool-call boundary and what does not.
 *
 * `query` is mocked and `tool()` calls are captured by name, matching `cli.request.scope.test.ts`'s
 * own reasoning: what's under test is what this adapter does with the file, not the engine's own
 * judgement. Unlike that file's request_scope tests, the report tool's effect (`reported`) is a
 * variable private to one `run()` call, not something observable on `context` afterwards — so the
 * handler is invoked *during* the mocked stream, before the `result` message that would otherwise
 * read `reported` still undefined.
 */
const { queryMock, mcpServerMock, toolMock, tools, shapes } = vi.hoisted(() => {
    const tools = new Map<string, (input: unknown) => unknown>();
    const shapes = new Map<string, unknown>();
    return {
        queryMock: vi.fn(),
        mcpServerMock: vi.fn(() => ({})),
        toolMock: vi.fn((name: string, _description: string, schema: unknown, handler: (input: unknown) => unknown) => {
            tools.set(name, handler);
            shapes.set(name, schema);
            return {};
        }),
        tools,
        shapes,
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

const resultSchema = z.object({ summary: z.string() });

const buildContext = (worktreeRoot: string) => ({
    project: 'p',
    cardId: '1',
    stage: 's',
    worktreeRoot,
    scope: new ScopeGuard({ worktreeRoot, allow: ['src/**'], alwaysAllowed: [] }),
    commands: new CommandAllowlist(['pnpm build']),
    scopeViolationPolicy: 'widen' as const,
    events: { append: async () => {} },
    logger: silentLogger,
});

const runInput = (stage: ReturnType<typeof makeStage>, context: ReturnType<typeof buildContext>) => ({
    stage,
    context,
    planPath: '/run/plan.md',
    title: 'a card',
    resultSchema,
});

/**
 * Simulates the engine calling `report_result` mid-run: the handler captured off `tools` is invoked
 * with `reportInput` as the model's tool-call arguments before the stream ends with a clean
 * `result` message. This is what actually exercises the file round trip — a plain `streamOf` never
 * calls the handler at all, since `query()` itself is mocked.
 */
const streamCallingReport = (reportInput: Record<string, unknown>) => ({
    [Symbol.asyncIterator]() {
        let step = 0;
        return {
            async next() {
                if (step === 0) {
                    step = 1;
                    await tools.get('report_result')!(reportInput);
                    return { done: false, value: { type: 'assistant', message: { content: [] } } };
                }
                return { done: false, value: { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } } };
            },
        };
    },
});

const makeWorktree = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'cli-report-result-'));
    await mkdir(join(root, 'src'), { recursive: true });
    return root;
};

describe('CliStageAgent report_result tool shape', () => {
    afterEach(() => {
        queryMock.mockReset();
        toolMock.mockClear();
        tools.clear();
        shapes.clear();
    });

    it('takes only an optional path, never the stage result schema’s own fields', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue({
            [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
        });
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage(), buildContext(root)) as never);

        const shape = shapes.get('report_result') as Record<string, unknown>;
        expect(Object.keys(shape)).toEqual(['path']);
        // The stage's own result field must not leak into the tool's input shape — that is the
        // whole point of the change: nothing beyond a path crosses the transport as arguments.
        expect(Object.keys(shape)).not.toContain('summary');
    });

    it('names the report file and its single-file contract in the tool description, echoing card 0058', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue({
            [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
        });
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage(), buildContext(root)) as never);

        const description = toolMock.mock.calls.find(call => call[0] === 'report_result')?.[1] as string;
        expect(description).toContain(REPORT_RESULT_PATH);
        expect(description).toContain('that file, and only that file, is how the result is delivered');
    });
});

describe('CliStageAgent report_result file round trip', () => {
    afterEach(() => {
        queryMock.mockReset();
        toolMock.mockClear();
        tools.clear();
        shapes.clear();
    });

    it('delivers the result read from the default report file, not anything passed as tool-call arguments', async () => {
        const root = await makeWorktree();
        await writeFile(join(root, REPORT_RESULT_PATH), JSON.stringify({ summary: 'wrote the thing' }), 'utf8');
        queryMock.mockReturnValue(streamCallingReport({}));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage(), buildContext(root)) as never)) as { result: unknown };

        expect(output.result).toEqual({ summary: 'wrote the thing' });
    });

    it('reads from a caller-supplied path instead of the default when one is given', async () => {
        const root = await makeWorktree();
        await writeFile(join(root, 'src', 'custom-result.json'), JSON.stringify({ summary: 'custom path' }), 'utf8');
        queryMock.mockReturnValue(streamCallingReport({ path: 'src/custom-result.json' }));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage(), buildContext(root)) as never)) as { result: unknown };

        expect(output.result).toEqual({ summary: 'custom path' });
    });

    it('leaves the result undefined when no report file was ever written', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(streamCallingReport({}));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage(), buildContext(root)) as never)) as { result: unknown };

        expect(output.result).toBeUndefined();
    });

    it('leaves the result undefined when the report file is not valid JSON', async () => {
        const root = await makeWorktree();
        await writeFile(join(root, REPORT_RESULT_PATH), '{ not json', 'utf8');
        queryMock.mockReturnValue(streamCallingReport({}));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage(), buildContext(root)) as never)) as { result: unknown };

        expect(output.result).toBeUndefined();
    });

    it('leaves the result undefined when the report file does not satisfy the stage’s result schema', async () => {
        const root = await makeWorktree();
        // `summary` is required by this stage's resultSchema; the file has an entirely different shape.
        await writeFile(join(root, REPORT_RESULT_PATH), JSON.stringify({ nonsense: true }), 'utf8');
        queryMock.mockReturnValue(streamCallingReport({}));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage(), buildContext(root)) as never)) as { result: unknown };

        expect(output.result).toBeUndefined();
    });

    it('returns an error to the model, naming which failure it was, rather than throwing', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue({
            [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
        });
        const agent = new CliStageAgent(silentLogger as never);
        await agent.run(runInput(makeStage(), buildContext(root)) as never);

        const handler = tools.get('report_result')!;
        const missing = (await handler({})) as { content: { type: string; text: string }[] };
        expect(missing.content[0]?.text).toContain('error');

        await writeFile(join(root, REPORT_RESULT_PATH), 'not json at all', 'utf8');
        const badJson = (await handler({})) as { content: { type: string; text: string }[] };
        expect(badJson.content[0]?.text).toContain('not valid JSON');

        await writeFile(join(root, REPORT_RESULT_PATH), JSON.stringify({ nonsense: true }), 'utf8');
        const badSchema = (await handler({})) as { content: { type: string; text: string }[] };
        expect(badSchema.content[0]?.text).toContain("does not match this stage's result schema");
    });

    it('refuses a report path that escapes the worktree, through the same scope check as a read', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue({
            [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
        });
        const agent = new CliStageAgent(silentLogger as never);
        await agent.run(runInput(makeStage(), buildContext(root)) as never);

        const handler = tools.get('report_result')!;
        const result = (await handler({ path: '../outside.json' })) as { content: { type: string; text: string }[] };
        expect(result.content[0]?.text).toContain('error');
    });

    it('unlinks the report file once the run ends, so it can never reach the diff', async () => {
        const root = await makeWorktree();
        await writeFile(join(root, REPORT_RESULT_PATH), JSON.stringify({ summary: 'done' }), 'utf8');
        queryMock.mockReturnValue(streamCallingReport({}));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage(), buildContext(root)) as never);

        await expect(readFile(join(root, REPORT_RESULT_PATH), 'utf8')).rejects.toThrow();
    });

    it('unlinks the report file even when the run is truncated by the wall clock, having never been reported', async () => {
        const root = await makeWorktree();
        await writeFile(join(root, REPORT_RESULT_PATH), JSON.stringify({ summary: 'leftover from a stalled run' }), 'utf8');
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

        const output = (await agent.run(runInput(makeStage({ maxWallClockMs: 20 }), buildContext(root)) as never)) as { truncated: boolean };

        expect(output.truncated).toBe(true);
        await expect(readFile(join(root, REPORT_RESULT_PATH), 'utf8')).rejects.toThrow();
    }, 10_000);

    it('does not throw when unlinking a report file that was never written', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(streamCallingReport({}));
        const agent = new CliStageAgent(silentLogger as never);

        await expect(agent.run(runInput(makeStage(), buildContext(root)) as never)).resolves.toBeDefined();
    });
});

describe('CliStageAgent report_result prompt wiring', () => {
    afterEach(() => {
        queryMock.mockReset();
        toolMock.mockClear();
        tools.clear();
        shapes.clear();
    });

    it('tells the model the report path and the schema the file must satisfy, since the tool call no longer carries it', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue({
            [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
        });
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage(), buildContext(root)) as never);

        const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
        expect(call.prompt).toContain(REPORT_RESULT_PATH);
        expect(call.prompt).toContain(JSON.stringify(z.toJSONSchema(resultSchema)));
    });
});
