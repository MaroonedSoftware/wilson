import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0181: a stage could write but never delete a file (`implementing`'s scope check has no
 * `rm`/`git clean`), and `review` could not write at all (`readonly` fails any write). Neither could
 * satisfy an acceptance criterion of the shape "generate X and inspect it" — see card 0171, which
 * deadlocked on exactly that. `SCRATCH_PREFIX` is a directory every stage may write under
 * unconditionally, removed recursively by `cli.stage.agent.ts` in the same `finally` that unlinks
 * `REPORT_RESULT_PATH`, before either verifier ever runs.
 *
 * These tests exercise the removal directly against the real filesystem, mirroring
 * `cli.report.result.test.ts`'s reasoning for the report file: the whole safety property is that
 * nothing under the prefix survives the run, on the pass path and on the truncated path alike.
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
const { SCRATCH_PREFIX, ScopeGuard } = await import('#modules/agent/scope.guard.js');
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

// Mirrors cli.report.result.test.ts's own helper: a plain `streamOf` never calls the report handler
// at all, since `query()` itself is mocked, so a stream that invokes it mid-run is what actually
// exercises the finally block on a clean completion.
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
    const root = await mkdtemp(join(tmpdir(), 'cli-scratch-'));
    await mkdir(join(root, 'src'), { recursive: true });
    return root;
};

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

describe('CliStageAgent scratch directory removal', () => {
    afterEach(() => {
        queryMock.mockReset();
        toolMock.mockClear();
        tools.clear();
        shapes.clear();
    });

    it('removes everything under the scratch prefix once the run ends, so none of it reaches a diff', async () => {
        const root = await makeWorktree();
        await mkdir(join(root, SCRATCH_PREFIX, 'nested'), { recursive: true });
        await writeFile(join(root, SCRATCH_PREFIX, 'probe.txt'), 'throwaway output', 'utf8');
        await writeFile(join(root, SCRATCH_PREFIX, 'nested', 'deeper.txt'), 'still throwaway', 'utf8');
        queryMock.mockReturnValue(streamCallingReport({}));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage(), buildContext(root)) as never);

        expect(await exists(join(root, SCRATCH_PREFIX))).toBe(false);
    });

    it('removes the scratch directory even when the run is truncated by the wall clock', async () => {
        const root = await makeWorktree();
        await mkdir(join(root, SCRATCH_PREFIX), { recursive: true });
        await writeFile(join(root, SCRATCH_PREFIX, 'leftover.txt'), 'from a stalled run', 'utf8');
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
        expect(await exists(join(root, SCRATCH_PREFIX))).toBe(false);
    }, 10_000);

    it('does not throw when there is no scratch directory to remove', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue(streamCallingReport({}));
        const agent = new CliStageAgent(silentLogger as never);

        await expect(agent.run(runInput(makeStage(), buildContext(root)) as never)).resolves.toBeDefined();
    });

    it('leaves a file outside the scratch prefix untouched, even one that merely starts with the same characters', async () => {
        // A prefix match on the raw string, rather than on path segments, would also sweep up a
        // sibling like `.wilson-scratch-backup/` — prove containment, not string prefixing, is what
        // decides what gets removed and what survives.
        const root = await makeWorktree();
        const decoy = `${SCRATCH_PREFIX.replace(/\/$/, '')}-backup`;
        await mkdir(join(root, decoy), { recursive: true });
        await writeFile(join(root, decoy, 'keep.txt'), 'not scratch', 'utf8');
        queryMock.mockReturnValue(streamCallingReport({}));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage(), buildContext(root)) as never);

        expect(await exists(join(root, decoy, 'keep.txt'))).toBe(true);
    });
});

describe('CliStageAgent scratch prompt wiring', () => {
    afterEach(() => {
        queryMock.mockReset();
        toolMock.mockClear();
        tools.clear();
        shapes.clear();
    });

    it('tells the model the scratch path exists, that it is writable everywhere including a readonly stage, and that it is wiped', async () => {
        const root = await makeWorktree();
        queryMock.mockReturnValue({
            [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
        });
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage(), buildContext(root)) as never);

        const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
        expect(call.prompt).toContain(SCRATCH_PREFIX);
        expect(call.prompt.toLowerCase()).toContain('read-only');
        expect(call.prompt.toLowerCase()).toContain('wiped');
    });
});
