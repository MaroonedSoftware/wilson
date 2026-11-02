import { afterEach, describe, expect, it, vi } from 'vitest';

/** What a stage does when its account runs out, with `query` mocked as in the other cli adapter suites. */
const { queryMock, mcpServerMock, toolMock } = vi.hoisted(() => ({
    queryMock: vi.fn(),
    mcpServerMock: vi.fn(() => ({})),
    toolMock: vi.fn(() => ({})),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: queryMock,
    createSdkMcpServer: mcpServerMock,
    tool: toolMock,
}));

const { CliStageAgent } = await import('#modules/agent/cli.stage.agent.js');
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

const runInput = (stage: ReturnType<typeof makeStage>) => ({
    stage,
    // `events` is a required stub, not an unused one: card 0126's turn.empty detection appends an
    // event whenever a run ends cleanly with no tool call and nothing reported — exactly the shape
    // of this file's "report tool never seen at all" fixture below.
    context: { worktreeRoot: '/tmp/worktree', events: { append: async () => {} } },
    planPath: '/run/plan.md',
    title: 'a card',
    resultSchema: z.object({ summary: z.string().optional() }),
});

const streamOf = (messages: unknown[]) => ({
    async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
    },
});

const refusal = {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_900_000_000 },
    uuid: 'u',
    session_id: 'session-1',
};
const errorResult = { type: 'result', subtype: 'error_during_execution', usage: { input_tokens: 10, output_tokens: 5 } };
const limit = { account: 'local', limitType: 'five_hour', resetsAt: 1_900_000_000_000 };

const accounts = () => ({ local: vi.fn(async () => ({ name: 'local' })), recordLimit: vi.fn(async () => {}) });

describe('CliStageAgent — usage limits', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    it('reports and records the limit when the engine ends its turn after a refusal', async () => {
        queryMock.mockReturnValue(streamOf([refusal, errorResult]));
        const service = accounts();

        const output = await new CliStageAgent(silentLogger as never, undefined, service as never).run(runInput(makeStage()) as never);

        expect(output.usageLimit).toEqual(limit);
        expect(output.engineFailure).toContain('five_hour');
        expect(service.recordLimit).toHaveBeenCalledWith(limit);
    });

    it('reports the limit when the stream closes with no result', async () => {
        queryMock.mockReturnValue(streamOf([refusal]));

        const output = await new CliStageAgent(silentLogger as never, undefined, accounts() as never).run(runInput(makeStage()) as never);

        expect(output.usageLimit).toEqual(limit);
    });

    it('reports the limit when the engine exits after a refusal', async () => {
        queryMock.mockReturnValue({
            async *[Symbol.asyncIterator]() {
                yield refusal;
                throw Object.assign(new Error('exited'), { errorClass: 'process', exitCode: 1 });
            },
        });

        const output = await new CliStageAgent(silentLogger as never, undefined, accounts() as never).run(runInput(makeStage()) as never);

        expect(output.usageLimit).toEqual(limit);
    });

    it('still runs when recording the limit fails', async () => {
        queryMock.mockReturnValue(streamOf([refusal, errorResult]));
        const service = { local: async () => ({ name: 'local' }), recordLimit: vi.fn(async () => Promise.reject(new Error('db down'))) };

        const output = await new CliStageAgent(silentLogger as never, undefined, service as never).run(runInput(makeStage()) as never);

        expect(output.usageLimit).toEqual(limit);
    });

    it('says nothing of a limit on an ordinary run', async () => {
        queryMock.mockReturnValue(streamOf([{ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } }]));
        const service = accounts();

        const output = await new CliStageAgent(silentLogger as never, undefined, service as never).run(runInput(makeStage()) as never);

        expect(output.usageLimit).toBeUndefined();
        expect(service.recordLimit).not.toHaveBeenCalled();
    });
});
