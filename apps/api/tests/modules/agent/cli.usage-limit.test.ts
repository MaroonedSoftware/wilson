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
const { MemoryHost } = await import('#tests/support/memory.host.js');
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
        expect(output.interrupted).toMatchObject({ sessionId: 'session-1' });
        expect(output.engineFailure).toBeUndefined();
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

    it('starts no engine for an account already known to be limited, keeping the session to resume', async () => {
        const service = { local: async () => ({ name: 'local', limit }), recordLimit: vi.fn(async () => {}) };
        const input = { ...runInput(makeStage()), resume: { sessionId: 'session-9' } };

        const output = await new CliStageAgent(silentLogger as never, undefined, service as never).run(input as never);

        expect(queryMock).not.toHaveBeenCalled();
        expect(output).toMatchObject({
            usageLimit: limit,
            heldUntil: limit.resetsAt,
            interrupted: { sessionId: 'session-9', wallClockMs: 0, steps: 0 },
        });
    });

    describe('choosing where to go next', () => {
        const running = (next: unknown) => {
            let calls = 0;
            return {
                local: vi.fn(async () => (calls++ === 0 ? { name: 'local' } : next)),
                recordLimit: vi.fn(async () => {}),
            };
        };
        const run = (service: unknown) => new CliStageAgent(silentLogger as never, undefined, service as never).run(runInput(makeStage()) as never);

        it('goes again at once when another account is free', async () => {
            queryMock.mockReturnValue(streamOf([refusal, errorResult]));
            const before = Date.now();

            const output = await run(running({ name: 'second', token: 'second-token' }));

            expect(output.heldUntil).toBeGreaterThanOrEqual(before);
            expect(output.heldUntil).toBeLessThanOrEqual(Date.now());
        });

        it('waits for the soonest reset when every account is limited', async () => {
            queryMock.mockReturnValue(streamOf([refusal, errorResult]));
            const soonest = { account: 'second', limitType: 'five_hour', resetsAt: 1_800_000_000_000 };

            const output = await run(running({ name: 'second', token: 'second-token', limit: soonest }));

            expect(output.heldUntil).toBe(soonest.resetsAt);
        });

        it('waits for this limit when the same account comes back, since the record did not take', async () => {
            queryMock.mockReturnValue(streamOf([refusal, errorResult]));

            const output = await run(running({ name: 'local' }));

            expect(output.heldUntil).toBe(limit.resetsAt);
        });

        it('waits for this limit when asking again fails', async () => {
            queryMock.mockReturnValue(streamOf([refusal, errorResult]));
            const service = {
                local: vi.fn().mockResolvedValueOnce({ name: 'local' }).mockRejectedValueOnce(new Error('db down')),
                recordLimit: vi.fn(async () => {}),
            };

            const output = await run(service);

            expect(output.heldUntil).toBe(limit.resetsAt);
        });

        it('asks the host, for an engine that runs on one', async () => {
            queryMock.mockReturnValue(streamOf([refusal, errorResult]));
            const engineAccount = vi.fn().mockResolvedValueOnce({ name: 'first', token: 'a' }).mockResolvedValueOnce({ name: 'second', token: 'b' });
            const input = runInput(makeStage());
            const context = { ...input.context, host: Object.assign(new MemoryHost(), { spawnClaude: vi.fn(), engineAccount }) };
            const before = Date.now();

            const output = await new CliStageAgent(silentLogger as never, undefined, { recordLimit: async () => {} } as never).run({
                ...input,
                context,
            } as never);

            expect(engineAccount).toHaveBeenCalledTimes(2);
            expect(output.usageLimit?.account).toBe('first');
            expect(output.heldUntil).toBeGreaterThanOrEqual(before);
        });
    });

    it('says nothing of a limit on an ordinary run', async () => {
        queryMock.mockReturnValue(streamOf([{ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } }]));
        const service = accounts();

        const output = await new CliStageAgent(silentLogger as never, undefined, service as never).run(runInput(makeStage()) as never);

        expect(output.usageLimit).toBeUndefined();
        expect(service.recordLimit).not.toHaveBeenCalled();
    });
});
