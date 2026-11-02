import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A stage records the engine's session id as it runs, so an attempt cut off by a restart leaves
 * behind the conversation it could resume from.
 */
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
const { StageInterrupt } = await import('#modules/agent/stage.interrupt.js');
type StageInterrupt = InstanceType<typeof StageInterrupt>;
const { z } = await import('zod');

const silentLogger = { info: () => {}, warn: vi.fn(), error: () => {}, debug: () => {} };

const stage = {
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
    maxSteps: 100,
    maxOutputTokens: 16000,
    maxInputTokens: 2_000_000,
    maxWallClockMs: 60_000,
    maxIdleMs: 60_000,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
};

const run = (append: (event: { type: string; payload?: unknown }) => Promise<void>, interrupts?: StageInterrupt) =>
    new CliStageAgent(silentLogger as never, undefined, undefined, interrupts).run({
        stage,
        context: {
            project: 'test',
            cardId: '0001',
            stage: 'implementing',
            worktreeRoot: '/tmp/worktree',
            events: { append },
            logger: silentLogger,
        },
        planPath: '/run/plan.md',
        title: 'a card',
        resultSchema: z.object({ summary: z.string().optional() }),
    } as never);

const streamOf = (...messages: unknown[]) => ({
    async *[Symbol.asyncIterator]() {
        yield* messages;
    },
});

const assistant = (sessionId?: string) => ({
    type: 'assistant',
    ...(sessionId ? { session_id: sessionId } : {}),
    message: { content: [{ type: 'text', text: 'working' }] },
});

const sessionsRecorded = (append: ReturnType<typeof vi.fn>) =>
    append.mock.calls.map(([event]) => event).filter(event => event.type === 'stage.engine-session');

describe('CliStageAgent engine session', () => {
    afterEach(() => vi.clearAllMocks());

    it('records the session once, however many messages carry it', async () => {
        queryMock.mockReturnValue(streamOf({ type: 'system', session_id: 'session-1' }, assistant('session-1'), assistant('session-1')));
        const append = vi.fn(async () => {});

        await run(append);

        expect(sessionsRecorded(append)).toEqual([
            {
                project: 'test',
                cardId: '0001',
                stage: 'implementing',
                type: 'stage.engine-session',
                payload: { sessionId: 'session-1' },
            },
        ]);
    });

    it('records a new session when the engine moves to one', async () => {
        queryMock.mockReturnValue(streamOf(assistant('session-1'), assistant('session-2')));
        const append = vi.fn(async () => {});

        await run(append);

        expect(sessionsRecorded(append).map(event => event.payload)).toEqual([{ sessionId: 'session-1' }, { sessionId: 'session-2' }]);
    });

    it('records nothing for a stream that names no session', async () => {
        queryMock.mockReturnValue(streamOf(assistant()));
        const append = vi.fn(async () => {});

        await run(append);

        expect(sessionsRecorded(append)).toEqual([]);
    });

    /** An engine that keeps working, and calls `onFirst` once it has said something. */
    const parkedStream = (onFirst: () => void) => ({
        async *[Symbol.asyncIterator]() {
            yield assistant('session-1');
            onFirst();
            await new Promise(() => {});
        },
    });

    it('stops a running engine and says it was interrupted, not failed', async () => {
        const interrupts = new StageInterrupt();
        queryMock.mockReturnValue(parkedStream(() => interrupts.interrupt()));

        const output = await run(vi.fn(async () => {}), interrupts);

        expect(output).toMatchObject({ interrupted: true, truncated: true });
        expect(output.budgetFailure).toBeUndefined();
        expect(output.engineFailure).toBeUndefined();
        expect(output.result).toBeUndefined();
    });

    it('interrupts a run that starts after shutdown has begun', async () => {
        const interrupts = new StageInterrupt();
        interrupts.interrupt();
        queryMock.mockReturnValue(parkedStream(() => {}));

        const output = await run(vi.fn(async () => {}), interrupts);

        expect(output.interrupted).toBe(true);
    });

    it('keeps running when the session cannot be recorded', async () => {
        queryMock.mockReturnValue(streamOf(assistant('session-1'), assistant('session-1')));
        const append = vi.fn(async (event: { type: string }) => {
            if (event.type === 'stage.engine-session') throw new Error('database down');
        });

        const output = await run(append);

        expect(output.engineFailure).toBeUndefined();
        expect(sessionsRecorded(append)).toHaveLength(1);
        expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining('could not record engine session'));
    });
});
