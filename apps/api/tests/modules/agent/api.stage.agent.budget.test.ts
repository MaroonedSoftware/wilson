import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ModelRegistry } from '#modules/agent/model.registry.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { ToolContext } from '#modules/agent/tools/index.js';

/**
 * Card 0015 wired an input-token budget and a wall-clock timeout into `ApiStageAgent`. Neither
 * existed before: the loop only ever stopped on `hasToolCall` or `stepCountIs`, and a run could not
 * be aborted at all.
 *
 * `ToolLoopAgent` is mocked rather than driven live — the point here is what `ApiStageAgent` wires
 * into it and does with what it returns, not the AI SDK's own loop.
 */
const { generateMock, capturedOptions } = vi.hoisted(() => ({
    generateMock: vi.fn(),
    capturedOptions: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock('ai', async importOriginal => {
    const actual = await importOriginal<typeof import('ai')>();
    return {
        ...actual,
        ToolLoopAgent: class {
            constructor(options: Record<string, unknown>) {
                capturedOptions.current = options;
            }
            generate(args: unknown) {
                return generateMock(args);
            }
        },
    };
});

const { ApiStageAgent } = await import('#modules/agent/api.stage.agent.js');

const makeStage = (overrides: Partial<StageConfig> = {}): StageConfig =>
    ({
        name: 'implementing',
        mode: 'agent',
        worktree: 'rw',
        adapter: 'api',
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
    }) as StageConfig;

const fakeContext = { worktreeRoot: '/tmp/worktree' } as unknown as ToolContext;
const fakeModels = { resolve: () => 'fake-model' } as unknown as ModelRegistry;
const resultSchema = z.object({ summary: z.string().optional() });

const runInput = (stage: StageConfig) => ({
    stage,
    context: fakeContext,
    planPath: '/run/plan.md',
    title: 'a card',
    resultSchema,
});

describe('ApiStageAgent budget wiring', () => {
    afterEach(() => {
        generateMock.mockReset();
        capturedOptions.current = undefined;
    });

    it('adds a token-budget stop condition to stopWhen, bound to the stage’s own cap', async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0 }, steps: [] });
        const stage = makeStage({ maxInputTokens: 1000 });
        const agent = new ApiStageAgent(fakeModels);

        await agent.run(runInput(stage));

        const stopWhen = capturedOptions.current?.stopWhen as ((arg: { steps: unknown[] }) => boolean)[];
        expect(stopWhen).toHaveLength(3);
        // Neither hasToolCall nor stepCountIs would stop the loop here — only the new budget
        // condition looks at cumulative input tokens at all.
        expect(stopWhen[2]!({ steps: [{ usage: { inputTokens: 1000 } }] })).toBe(true);
        expect(stopWhen[2]!({ steps: [{ usage: { inputTokens: 999 } }] })).toBe(false);
    });

    it('passes an abortSignal timed to the stage’s maxWallClockMs into generate', async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0 }, steps: [] });
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
        const stage = makeStage({ maxWallClockMs: 42_000 });
        const agent = new ApiStageAgent(fakeModels);

        await agent.run(runInput(stage));

        expect(timeoutSpy).toHaveBeenCalledWith(42_000);
        const args = generateMock.mock.calls[0]?.[0] as { abortSignal?: AbortSignal };
        expect(args.abortSignal).toBeInstanceOf(AbortSignal);
        timeoutSpy.mockRestore();
    });

    it('catches an aborted run and fails the stage through the normal path instead of throwing', async () => {
        // A wall-clock abort must not propagate as an unhandled error — the whole point is that this
        // becomes an ordinary stage failure, not a crash the job runner has to catch.
        generateMock.mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        const agent = new ApiStageAgent(fakeModels);

        const output = await agent.run(runInput(makeStage()));

        expect(output).toEqual({ truncated: true });
    });

    it('still throws a non-abort error rather than silently truncating', async () => {
        generateMock.mockRejectedValue(new Error('provider is down'));
        const agent = new ApiStageAgent(fakeModels);

        await expect(agent.run(runInput(makeStage()))).rejects.toThrow('provider is down');
    });

    it('reports a budgetFailure once the run’s input tokens meet the cap', async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 1000, outputTokens: 10 }, steps: [] });
        const agent = new ApiStageAgent(fakeModels);

        const output = (await agent.run(runInput(makeStage({ maxInputTokens: 1000 })))) as { budgetFailure?: string };

        expect(output.budgetFailure).toContain('used 1000, cap 1000');
    });

    it('leaves budgetFailure undefined while the run stays under its cap', async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 500, outputTokens: 10 }, steps: [] });
        const agent = new ApiStageAgent(fakeModels);

        const output = (await agent.run(runInput(makeStage({ maxInputTokens: 1000 })))) as { budgetFailure?: string };

        expect(output.budgetFailure).toBeUndefined();
    });
});
