import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0067. Three deaths of card 0066's review stage each recorded exactly one thing:
 * `stage.failed {"error":"Claude Code process aborted by user"}`, with none of the runner's own
 * timers having fired. That string is what the SDK's process lifecycle stamps on *every* abnormal
 * exit it produces — including, per its own source, the case where nothing this runner did asked for
 * an abort at all (`errorClass: "aborted"`, no `exitCode`, no `signal`) — so the message alone cannot
 * tell "we stopped it" from "it died". The old catch block made exactly that mistake: it matched on
 * `err.name === 'AbortError'`, which the SDK's error never carries, so a run that died on its own fell
 * straight through to a bare rethrow with nothing attributable in the log, or — worse — was misfiled
 * as a wall-clock timeout it never actually hit whenever `stepsExhausted` was false.
 *
 * `query` is mocked, matching every other `cli.stage.agent` test's own reasoning: what's under test
 * is what this adapter does with an abnormal exit, not the engine's own judgement.
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
    maxSteps: 100,
    maxOutputTokens: 16000,
    maxInputTokens: 2_000_000,
    // Long enough that none of these tests come anywhere near it — the whole point is that neither
    // control fires, and a short cap here would make the test ambiguous about which path produced
    // the result.
    maxWallClockMs: 60_000,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
    ...overrides,
});

const appended: unknown[] = [];

const runInput = (stage: ReturnType<typeof makeStage>) => ({
    stage,
    context: {
        project: 'test',
        cardId: '0001',
        stage: 'implementing',
        worktreeRoot: '/tmp/worktree',
        events: { append: async (e: unknown) => void appended.push(e) },
        logger: silentLogger,
    },
    planPath: '/run/plan.md',
    title: 'a card',
    resultSchema: z.object({ summary: z.string().optional() }),
});

type MockOptions = { stderr?: (data: string) => void };
const options = (): MockOptions => (queryMock.mock.calls[0]?.[0] as { options: MockOptions }).options;

const assistantMessage = () => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });

/**
 * Models the engine's own process lifecycle rejecting the read — never the runner's abortController.
 * Real shapes taken from the installed SDK's own `errorClass` tags: `"aborted"` with no exit detail
 * is exactly the incident this card exists to diagnose; `"process_exited_nonzero"` and
 * `"process_killed_by_signal"` are the same lifecycle's other two abnormal-exit shapes.
 */
const engineDies = (err: unknown, stderrChunks: string[] = []) => ({
    async *[Symbol.asyncIterator]() {
        yield assistantMessage();
        for (const chunk of stderrChunks) options().stderr?.(chunk);
        throw err;
    },
});

const abortedByUser = () =>
    Object.assign(new Error('Claude Code process aborted by user'), {
        name: 'TelemetrySafeError',
        telemetryMessage: 'Claude Code process aborted by user',
        errorClass: 'aborted',
    });

describe('CliStageAgent engine failure attribution', () => {
    afterEach(() => {
        queryMock.mockReset();
        appended.length = 0;
    });

    /**
     * The reported incident, reproduced directly: the engine's own lifecycle rejects the read with
     * exactly the error the SDK stamps on an abort nobody here asked for, while neither the
     * wall-clock nor the idle nor the step control has fired. This must resolve as an engine failure
     * naming what happened — not a bare rethrow (the old `AbortError`-name match never matched this
     * error) and not a wall-clock budget failure (the old fallback for anything that wasn't
     * `stepsExhausted`, regardless of whether the wall clock had actually elapsed).
     */
    it('reports an unrequested abort as an engine failure, not a rethrow or a misattributed budget failure', async () => {
        queryMock.mockReturnValue(engineDies(abortedByUser()));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as {
            truncated: boolean;
            engineFailure?: string;
            budgetFailure?: string;
        };

        expect(output.truncated).toBe(true);
        expect(output.engineFailure).toBeDefined();
        expect(output.engineFailure).toMatch(/none of the runner's wall-clock, idle or step controls fired/);
        expect(output.engineFailure).toContain('Claude Code process aborted by user');
        // The exact misattribution this card exists to fix: a run cut off by nothing the runner did
        // must never read as if a budget was what stopped it.
        expect(output.budgetFailure).toBeUndefined();
    });

    it('logs the abort as an engine.failed event carrying the SDK-reported errorClass and message', async () => {
        queryMock.mockReturnValue(engineDies(abortedByUser()));
        const agent = new CliStageAgent(silentLogger as never);

        await agent.run(runInput(makeStage()) as never);

        const engineEvent = appended.find(
            (e): e is { type: string; payload: Record<string, unknown> } => (e as { type: string }).type === 'engine.failed',
        );
        expect(engineEvent).toBeDefined();
        expect(engineEvent?.payload.errorClass).toBe('aborted');
        expect(engineEvent?.payload.message).toBe('Claude Code process aborted by user');
        // Nothing to report for exit code or signal on this shape — must not be invented.
        expect('exitCode' in (engineEvent?.payload ?? {})).toBe(false);
        expect('signal' in (engineEvent?.payload ?? {})).toBe(false);
    });

    it('captures the exit code the engine process reported and surfaces it in both the result and the event', async () => {
        const err = Object.assign(new Error('Claude Code process exited with code 1'), {
            errorClass: 'process_exited_nonzero',
            exitCode: 1,
        });
        queryMock.mockReturnValue(engineDies(err));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as { engineFailure?: string };

        expect(output.engineFailure).toContain('exit code 1');
        const engineEvent = appended.find(
            (e): e is { type: string; payload: Record<string, unknown> } => (e as { type: string }).type === 'engine.failed',
        );
        expect(engineEvent?.payload.exitCode).toBe(1);
    });

    it('captures the signal that killed the engine process and surfaces it in both the result and the event', async () => {
        const err = Object.assign(new Error('Claude Code process terminated by signal SIGKILL'), {
            errorClass: 'process_killed_by_signal',
            signal: 'SIGKILL',
        });
        queryMock.mockReturnValue(engineDies(err));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as { engineFailure?: string };

        expect(output.engineFailure).toContain('signal SIGKILL');
        const engineEvent = appended.find(
            (e): e is { type: string; payload: Record<string, unknown> } => (e as { type: string }).type === 'engine.failed',
        );
        expect(engineEvent?.payload.signal).toBe('SIGKILL');
    });

    /**
     * The `stderr` option is wired independent of how the read loop ends, precisely so it survives an
     * engine that dies before producing a `result` message the SDK could build its own tail from.
     * Captured here, it must reach both the returned failure detail and the logged event.
     */
    it('carries captured stderr into the engine failure detail and the logged event', async () => {
        const err = Object.assign(new Error('Claude Code process aborted by user'), { errorClass: 'aborted' });
        queryMock.mockReturnValue(engineDies(err, ['fatal: out of memory\n']));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as { engineFailure?: string };

        expect(output.engineFailure).toContain('fatal: out of memory');
        const engineEvent = appended.find(
            (e): e is { type: string; payload: Record<string, unknown> } => (e as { type: string }).type === 'engine.failed',
        );
        expect(engineEvent?.payload.stderr).toContain('fatal: out of memory');
    });

    /**
     * An error the engine's own process lifecycle never tagged did not come from an abnormal exit at
     * all — a kicked-back scope request is exactly this shape — and must keep propagating as the bare
     * error it is rather than being reinterpreted as an engine fault the reader would go looking for
     * a process exit to explain.
     */
    it('keeps propagating an error the engine process lifecycle never tagged, rather than reinterpreting it as an engine failure', async () => {
        const scopeKickback = Object.assign(new Error('scope request kicked back'), { name: 'ScopeKickbackError' });
        queryMock.mockReturnValue(engineDies(scopeKickback));
        const agent = new CliStageAgent(silentLogger as never);

        await expect(agent.run(runInput(makeStage()) as never)).rejects.toThrow('scope request kicked back');
        expect(appended.some(e => (e as { type: string }).type === 'engine.failed')).toBe(false);
    });

    /**
     * When the wall clock genuinely is what stopped the run, that attribution must win even though
     * the rejected error itself carries an engine `errorClass` — the runner's own record of which
     * control fired takes priority over what the error happens to look like, which is the whole
     * point of attributing by `stoppedBecause` instead of the error's shape.
     */
    it('still attributes a genuine wall-clock stop correctly, even when the rejected error carries an engine errorClass', async () => {
        queryMock.mockImplementation(({ options: opts }: { options: { abortController: AbortController } }) => ({
            [Symbol.asyncIterator]() {
                return {
                    next: () =>
                        new Promise((_resolve, reject) => {
                            opts.abortController.signal.addEventListener('abort', () => reject(abortedByUser()));
                        }),
                };
            },
        }));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage({ maxWallClockMs: 20 })) as never)) as {
            budgetFailure?: string;
            engineFailure?: string;
        };

        expect(output.budgetFailure).toBe('wall-clock budget exceeded: cap 20ms');
        expect(output.engineFailure).toBeUndefined();
        expect(appended.some(e => (e as { type: string }).type === 'engine.failed')).toBe(false);
    }, 10_000);
});
