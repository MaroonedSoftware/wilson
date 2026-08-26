import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ModelRegistry } from '#modules/agent/model.registry.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { ToolContext } from '#modules/agent/tools/index.js';

/**
 * Card 0097: this adapter's tools already carry their real names in the schema the model sees
 * (`buildTools`), so nothing here needed to move like `cli.stage.agent.ts`'s delete-tool naming
 * did. What the same commit *did* add to `ApiStageAgent` is the "don't leave an it.skip behind"
 * consequence, appended to `instructions` only when the stage is writable and actually checks test
 * counts (`stage.testReportPath !== undefined`, the same signal `TestingVerifier.checkCounts`
 * keys off). Before this change, `instructions` was passed straight through as `stage.instructions`
 * with no such addition, for any stage.
 *
 * `ToolLoopAgent` is mocked rather than driven live, matching `api.stage.agent.budget.test.ts`'s own
 * reasoning: what's under test is what this adapter wires into it, not the AI SDK's own loop.
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

const instructionsFromCall = (): string => capturedOptions.current?.instructions as string;

describe('ApiStageAgent instructions wiring', () => {
    afterEach(() => {
        generateMock.mockReset();
        capturedOptions.current = undefined;
    });

    it('still carries stage.instructions through verbatim as the base of the prompt', async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0 }, steps: [] });
        const agent = new ApiStageAgent(fakeModels);

        await agent.run(runInput(makeStage({ instructions: 'do the thing' })));

        expect(instructionsFromCall()).toContain('do the thing');
    });

    it('appends the skipped-test warning when a writable stage checks test counts', async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0 }, steps: [] });
        const agent = new ApiStageAgent(fakeModels);

        await agent.run(runInput(makeStage({ worktree: 'rw', testReportPath: 'test-report.json' })));

        expect(instructionsFromCall()).toContain('it.skip');
    });

    it('omits the skipped-test warning when the stage has no test-count check, even if writable', async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0 }, steps: [] });
        const agent = new ApiStageAgent(fakeModels);

        await agent.run(runInput(makeStage({ worktree: 'rw', testReportPath: undefined })));

        expect(instructionsFromCall()).not.toContain('it.skip');
    });

    it('omits the skipped-test warning for a readonly stage, even one with a testReportPath set', async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0 }, steps: [] });
        const agent = new ApiStageAgent(fakeModels);

        await agent.run(runInput(makeStage({ worktree: 'readonly', testReportPath: 'test-report.json' })));

        expect(instructionsFromCall()).not.toContain('it.skip');
    });
});
