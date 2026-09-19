import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ModelRegistry } from '#modules/agent/model.registry.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { ToolContext } from '#modules/agent/tools/index.js';

/**
 * Card 0244: `ApiStageAgent.run` now takes an optional `learningsPath` (`AgentRunInput`) and, when
 * it is set, adds one line to the prompt — next to the plan-path line — telling the agent to read
 * the project's learnings before starting, framed as guidance to follow rather than material to
 * weigh (the constraint distinguishing it from `contextBlock`'s untrusted framing). When
 * `learningsPath` is unset (an empty or absent document — PROJECT.md decision 8), the prompt must
 * carry no learnings line at all, matching this file's sibling `api.stage.agent.prompt.test.ts`
 * pattern of mocking `ToolLoopAgent` and reading the captured `prompt` back.
 */
const { generateMock } = vi.hoisted(() => ({
    generateMock: vi.fn(),
}));

vi.mock('ai', async importOriginal => {
    const actual = await importOriginal<typeof import('ai')>();
    return {
        ...actual,
        ToolLoopAgent: class {
            constructor(_options: Record<string, unknown>) {}
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

const runInput = (learningsPath?: string) => ({
    stage: makeStage(),
    context: fakeContext,
    planPath: '/run/plan.md',
    learningsPath,
    title: 'a card',
    resultSchema,
    baseSha: 'deadbeef',
});

const promptFromCall = (): string => (generateMock.mock.calls[0]?.[0] as { prompt: string }).prompt;

describe('ApiStageAgent learnings prompt wiring (card 0244)', () => {
    afterEach(() => {
        generateMock.mockReset();
    });

    it('tells the agent to read the learnings path before starting, when one is set', async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0 }, steps: [] });
        const agent = new ApiStageAgent(fakeModels);

        await agent.run(runInput('/run/cards/0001/learnings.md') as never);

        const prompt = promptFromCall();
        expect(prompt).toContain('/run/cards/0001/learnings.md');
        expect(prompt).toContain('Before you start, also read the project');
    });

    it('frames the learnings as guidance to follow, not material to weigh', async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0 }, steps: [] });
        const agent = new ApiStageAgent(fakeModels);

        await agent.run(runInput('/run/cards/0001/learnings.md') as never);

        expect(promptFromCall()).toContain('follow them like the plan, not material');
    });

    it('adds no learnings line at all when learningsPath is unset', async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0 }, steps: [] });
        const agent = new ApiStageAgent(fakeModels);

        await agent.run(runInput(undefined) as never);

        const prompt = promptFromCall();
        expect(prompt).not.toContain('learnings');
        expect(prompt).not.toContain('/run/cards/0001/learnings.md');
    });
});
