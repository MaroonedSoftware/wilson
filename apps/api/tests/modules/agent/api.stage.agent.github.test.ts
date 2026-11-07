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

/**
 * The api adapter has no guard, so the tool it builds must refuse on its own. These call the tool's
 * `execute` exactly as the model's tool loop would, with `fetch` stubbed so nothing leaves the machine.
 */
describe('ApiStageAgent: the GitHub tool it builds', () => {
    const events: { type: string; payload?: Record<string, unknown> }[] = [];
    const context = {
        project: 'p',
        cardId: '0013',
        stage: 'implementing',
        worktreeRoot: '/tmp/worktree',
        events: {
            append: async (event: { type: string; payload?: Record<string, unknown> }) => {
                events.push(event);
            },
        },
    } as unknown as ToolContext;

    const githubToolOf = async () => {
        generateMock.mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0 }, steps: [] });
        await new ApiStageAgent(fakeModels).run({
            stage: makeStage({ webAccess: 'github' }),
            context,
            planPath: '/run/plan.md',
            title: 'a card',
            resultSchema: z.object({ summary: z.string().optional() }),
            baseSha: 'deadbeef',
        });
        const tools = capturedOptions.current!.tools as Record<string, { execute: (input: { url: string }, o: unknown) => Promise<string> }>;
        const github = tools[GITHUB_TOOL]!;
        return (url: string) => github.execute({ url }, { toolCallId: 't1', messages: [] });
    };

    afterEach(() => {
        generateMock.mockReset();
        capturedOptions.current = undefined;
        vi.unstubAllGlobals();
        events.length = 0;
    });

    it('AC2, AC8, AC11: reads a file with a plain GET and records the call with its URL', async () => {
        const fetchMock = vi.fn(
            async (_url: string, _init?: RequestInit) => new Response('# readme', { status: 200, headers: { 'content-type': 'text/plain' } }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const read = await githubToolOf();

        const reply = await read('https://raw.githubusercontent.com/o/r/main/README.md');

        expect(reply).toBe('https://raw.githubusercontent.com/o/r/main/README.md\nHTTP 200\n\n# readme');
        const init = fetchMock.mock.calls[0]![1]!;
        expect(init.method).toBe('GET');
        expect(init.body).toBeUndefined();
        expect(Object.keys(init.headers as Record<string, string>).map(h => h.toLowerCase())).not.toContain('authorization');
        expect(events).toEqual([
            expect.objectContaining({
                type: 'tool.executed',
                payload: { tool: GITHUB_TOOL, url: 'https://raw.githubusercontent.com/o/r/main/README.md', status: 200 },
            }),
        ]);
    });

    it.each([
        ['another host', 'https://example.com/x', /example\.com is not a GitHub host/],
        ['http', 'http://raw.githubusercontent.com/o/r/main/x', /only https/],
    ])('AC3, AC10: refuses %s without fetching, and records it as denied', async (_label, url, reason) => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const read = await githubToolOf();

        const reply = await read(url);

        expect(reply).toMatch(/^error: /);
        expect(reply).toMatch(reason);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(events).toEqual([expect.objectContaining({ type: 'tool.denied', payload: expect.objectContaining({ tool: GITHUB_TOOL, url }) })]);
    });

    it('AC3, AC10: refuses a redirect off GitHub without following it', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'https://evil.example/' } }));
        vi.stubGlobal('fetch', fetchMock);
        const read = await githubToolOf();

        const reply = await read('https://github.com/o/r');

        expect(reply).toMatch(/redirects to https:\/\/evil\.example\/, which was not followed/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(events[0]).toMatchObject({ type: 'tool.denied', payload: { url: 'https://github.com/o/r' } });
    });
});
