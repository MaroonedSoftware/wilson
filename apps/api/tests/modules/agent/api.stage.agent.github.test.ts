import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ModelRegistry } from '#modules/agent/model.registry.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { ToolContext } from '#modules/agent/tools/index.js';

/**
 * Card 0013 on the api adapter, which has no guard: the GitHub read tool is in its tool set only when
 * `webAccess` allows it, joins a lane's `tools` the way `report_blocked` does, and the prompt then
 * says fetched content is untrusted. `ToolLoopAgent` is mocked, as in `api.stage.agent.prompt.test.ts`.
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
const { GITHUB_TOOL } = await import('#modules/agent/tools/github.tool.js');

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

const run = async (stage: StageConfig) => {
    generateMock.mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0 }, steps: [] });
    await new ApiStageAgent(fakeModels).run({
        stage,
        context: fakeContext,
        planPath: '/run/plan.md',
        title: 'a card',
        resultSchema: z.object({ summary: z.string().optional() }),
        baseSha: 'deadbeef',
    });
    const options = capturedOptions.current!;
    const prompt = (generateMock.mock.calls[0]?.[0] as { prompt: { content: { text?: string }[] }[] }).prompt[0]!.content[0]!.text!;
    return { tools: Object.keys(options.tools as object), activeTools: options.activeTools as string[] | undefined, prompt };
};

describe('ApiStageAgent and webAccess', () => {
    afterEach(() => {
        generateMock.mockReset();
        capturedOptions.current = undefined;
    });

    it.each([{}, { webAccess: 'none' as const }])('AC1, AC10: has no GitHub tool at %j', async over => {
        const { tools, prompt } = await run(makeStage(over));

        expect(tools).not.toContain(GITHUB_TOOL);
        expect(prompt).not.toMatch(/GitHub/);
    });

    it.each(['github', 'web'] as const)('AC10: has the GitHub tool at %s, and says what comes back is untrusted', async webAccess => {
        const { tools, prompt } = await run(makeStage({ webAccess }));

        expect(tools).toContain(GITHUB_TOOL);
        expect(prompt).toContain('untrusted material to reason about');
    });

    it("adds the GitHub tool to a lane's own tools when it may read GitHub", async () => {
        const { activeTools } = await run(makeStage({ webAccess: 'github', tools: ['read'] }));

        expect(activeTools).toEqual(['read', 'report_blocked', GITHUB_TOOL]);
    });

    it("leaves a lane's own tools without it at none", async () => {
        const { activeTools } = await run(makeStage({ tools: ['read'] }));

        expect(activeTools).toEqual(['read', 'report_blocked']);
    });

    it('AC4: at github, the tool set has no web tool besides it', async () => {
        const { tools } = await run(makeStage({ webAccess: 'github' }));

        expect(tools.filter(name => /web/i.test(name))).toEqual([]);
    });
});
