import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `report_blocked` on the `cli` adapter, with `query` mocked and `tool()` calls captured, as in
 * `cli.report.result.test.ts`. The handler runs mid-stream. What a real engine does when stopped there
 * is `cli.blocked.probe.ts`'s question.
 */
const { queryMock, mcpServerMock, toolMock, tools } = vi.hoisted(() => {
    const tools = new Map<string, (input: unknown) => Promise<{ content: { text: string }[] }>>();
    return {
        queryMock: vi.fn(),
        mcpServerMock: vi.fn(() => ({})),
        toolMock: vi.fn(
            (name: string, _description: string, _schema: unknown, handler: (input: unknown) => Promise<{ content: { text: string }[] }>) => {
                tools.set(name, handler);
                return {};
            },
        ),
        tools,
    };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock, createSdkMcpServer: mcpServerMock, tool: toolMock }));

const { CliStageAgent, createToolGuard } = await import('#modules/agent/cli.stage.agent.js');
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

const buildContext = (worktreeRoot: string) => ({
    project: 'p',
    cardId: '0001',
    stage: 'implementing',
    worktreeRoot,
    scope: new ScopeGuard({ worktreeRoot, allow: ['src/**'], alwaysAllowed: [] }),
    commands: new CommandAllowlist(['pnpm build']),
    scopeViolationPolicy: 'widen' as const,
    events: { append: async () => {} },
    logger: silentLogger,
});

const question = { category: 'decision', tried: 'read it', question: 'Red or blue?' };

const assistant = (id: string, inputTokens: number) => ({
    type: 'assistant',
    message: { id, content: [], usage: { input_tokens: inputTokens, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

/** Hands back `messages` in turn, then `last()`, which is where a test makes the run's tool calls. */
const streamOf = (messages: unknown[], last: () => Promise<IteratorResult<unknown>>) => ({
    [Symbol.asyncIterator]() {
        let step = 0;
        return {
            next: async (): Promise<IteratorResult<unknown>> => (step < messages.length ? { done: false, value: messages[step++] } : last()),
        };
    },
});

const run = async (stage = makeStage()) => {
    const root = await mkdtemp(join(tmpdir(), 'cli-blocked-'));
    await mkdir(join(root, 'src'), { recursive: true });
    return new CliStageAgent(silentLogger as never).run({
        stage,
        context: buildContext(root),
        planPath: '/run/plan.md',
        title: 'a card',
        resultSchema: z.object({ summary: z.string() }),
        baseSha: 'abc',
    } as never);
};

const promptOf = (): string => (queryMock.mock.calls[0]![0] as { prompt: string }).prompt;

describe('CliStageAgent report_blocked', () => {
    afterEach(() => {
        queryMock.mockReset();
        toolMock.mockClear();
        tools.clear();
    });

    it('stops at once, without waiting for the engine to say anything more', async () => {
        let abandoned = false;
        queryMock.mockReturnValue(
            streamOf([assistant('m1', 100)], async () => {
                if (tools.has('report_blocked') && !abandoned) {
                    abandoned = true;
                    await tools.get('report_blocked')!(question);
                }
                // Parked, as a live engine's read is while it carries on with the next turn.
                return new Promise(() => {});
            }),
        );

        const output = await run();

        expect(output.blocked).toEqual(question);
        expect(output.truncated).toBe(false);
        expect(output.usage).toMatchObject({ inputTokens: 100, outputTokens: 2 });
        expect(output.result).toBeUndefined();
    });

    it('tells the engine to stop', async () => {
        queryMock.mockReturnValue(
            streamOf([], async () => {
                await tools.get('report_blocked')!(question);
                return new Promise(() => {});
            }),
        );

        await run();

        const { abortController } = (queryMock.mock.calls[0]![0] as { options: { abortController: AbortController } }).options;
        expect(abortController.signal.aborted).toBe(true);
    });

    it('still ends with the question when the abort is what unblocks the read', async () => {
        queryMock.mockReturnValue(
            streamOf([], async () => {
                await tools.get('report_blocked')!(question);
                throw Object.assign(new Error('Claude Code process aborted by user'), { errorClass: 'aborted' });
            }),
        );

        const output = await run();

        expect(output.blocked).toEqual(question);
        expect(output.engineFailure).toBeUndefined();
    });

    it('refuses a question from a run that has already reported', async () => {
        let reply: { content: { text: string }[] } | undefined;
        const root = await mkdtemp(join(tmpdir(), 'cli-blocked-'));
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, REPORT_RESULT_PATH), JSON.stringify({ summary: 'done' }), 'utf8');
        queryMock.mockReturnValue(
            streamOf([], async () => {
                if (!reply) {
                    await (tools.get('report_result') as unknown as (input: unknown) => Promise<unknown>)({});
                    reply = await tools.get('report_blocked')!(question);
                }
                return { done: false, value: { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } } };
            }),
        );

        const output = await new CliStageAgent(silentLogger as never).run({
            stage: makeStage(),
            context: buildContext(root),
            planPath: '/run/plan.md',
            title: 'a card',
            resultSchema: z.object({ summary: z.string() }),
            baseSha: 'abc',
        } as never);

        expect(reply?.content[0]?.text).toMatch(/already reported/);
        expect(output.blocked).toBeUndefined();
        expect(output.result).toEqual({ summary: 'done' });
    });

    it('offers the tool and says when to use it, to a lane', async () => {
        queryMock.mockReturnValue(streamOf([], async () => ({ done: false, value: { type: 'result', subtype: 'success' } })));

        await run();

        expect(tools.has('report_blocked')).toBe(true);
        expect(promptOf()).toContain('mcp__wilson__report_blocked');
        expect(promptOf()).toContain('Ask only what');
    });

    it('offers it to a step neither as a tool nor in the prompt', async () => {
        queryMock.mockReturnValue(streamOf([], async () => ({ done: false, value: { type: 'result', subtype: 'success' } })));

        await run(makeStage({ step: 'challenge' }));

        expect(tools.has('report_blocked')).toBe(false);
        expect(promptOf()).not.toContain('report_blocked');
    });

    it('is let through by the guard, even on a read-only stage', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cli-blocked-'));
        const guard = createToolGuard(buildContext(root) as never, 'readonly');

        await expect(guard('mcp__wilson__report_blocked', question, { signal: new AbortController().signal } as never)).resolves.toEqual({
            behavior: 'allow',
        });
    });
});
