import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ModelRegistry } from '#modules/agent/model.registry.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { ToolContext } from '#modules/agent/tools/index.js';

/**
 * Card 0024: `ApiStageAgent`'s prompt — the string handed to `ToolLoopAgent.generate()`, distinct
 * from `instructions` (covered by `api.stage.agent.instructions.test.ts`) — has to name the
 * worktree's fork point so a stage that needs to look at its own diff (testing and review chief
 * among them) knows what `git diff` to run. A bare `git diff` shows nothing on a resumed,
 * fully-committed branch, and `git diff main` lies the moment main has moved since the branch was
 * cut, so the runner is the only thing that can tell the agent the right sha.
 *
 * `ToolLoopAgent` is mocked rather than driven live, matching `api.stage.agent.budget.test.ts`'s own
 * reasoning: what's under test is the prompt this adapter builds, not the AI SDK's own loop.
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

const runInput = (stage: StageConfig, baseSha = 'deadbeef') => ({
    stage,
    context: fakeContext,
    planPath: '/run/plan.md',
    title: 'a card',
    resultSchema,
    baseSha,
});

const promptFromCall = (): string => (generateMock.mock.calls[0]?.[0] as { prompt: string }).prompt;

describe('ApiStageAgent prompt wiring', () => {
    afterEach(() => {
        generateMock.mockReset();
        capturedOptions.current = undefined;
    });

    it("names the run's baseSha as the sha to diff against for the card's whole diff", async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0 }, steps: [] });
        const agent = new ApiStageAgent(fakeModels);

        await agent.run(runInput(makeStage(), 'cafef00d'));

        expect(promptFromCall()).toContain('git diff cafef00d');
    });

    it('says the diff is what the verifier measures and what a finding must cite', async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0 }, steps: [] });
        const agent = new ApiStageAgent(fakeModels);

        await agent.run(runInput(makeStage()));

        expect(promptFromCall()).toContain("this is what the\nverifier measures and what a finding must cite.");
    });
});
