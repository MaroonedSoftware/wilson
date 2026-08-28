import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0132: `PlanSessionAgent` holds one `query()` call open for a card's whole planning
 * conversation — the prompt is a `TurnInbox` (an `AsyncIterable`) rather than a plain string, so
 * pushing a second turn continues the same engine session instead of starting a fresh one.
 *
 * `query` is mocked rather than driven against a real engine, matching `cli.stage.agent.prompt.test.ts`'s
 * own reasoning: what's under test is how this class drives the stream, not the engine's own
 * judgement. The mock reads directly off the `prompt` (the real `TurnInbox`) so it can react to
 * turns pushed onto it exactly the way a real engine would react to streamed input.
 */
const { queryMock, streamReturnMock } = vi.hoisted(() => ({
    queryMock: vi.fn(),
    streamReturnMock: vi.fn(async () => ({ value: undefined, done: true as const })),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: queryMock,
    createSdkMcpServer: vi.fn(() => ({})),
    tool: vi.fn(() => ({})),
}));

const { PlanSessionAgent } = await import('#modules/agent/plan.session.agent.js');

/**
 * A fake engine: reads one pushed user turn at a time off the real `TurnInbox` passed as
 * `options.prompt`, and for each replies with two separate assistant messages (to prove
 * incremental delivery) followed by a result message, before looping back to wait for the next
 * turn. `history` accumulates every turn's text inside the closure `query()` is called with, so a
 * reply naming everything in `history` is only possible if the same engine call served every turn
 * — a regression back to a fresh `query()` per turn would reset it and break that assertion.
 */
const fakeEngine = (sessionId = 'sess-abc') => {
    const history: string[] = [];
    async function* engine() {
        const promptIterator = (queryMock.mock.calls.at(-1)?.[0] as { prompt: AsyncIterable<{ message: { content: string } }> }).prompt[
            Symbol.asyncIterator
        ]();
        for (;;) {
            const next = await promptIterator.next();
            if (next.done) return;
            history.push(next.value.message.content);
            yield { type: 'assistant', message: { content: [{ type: 'text', text: `part1[${history.join('|')}]` }] }, session_id: sessionId } as never;
            yield { type: 'assistant', message: { content: [{ type: 'text', text: 'part2' }] }, session_id: sessionId } as never;
            yield { type: 'result', subtype: 'success', session_id: sessionId } as never;
        }
    }
    return engine();
};

/** Registers the next `query()` call to return a fresh fake engine, wired to whatever prompt it is called with. */
const armQuery = (sessionId?: string): void => {
    queryMock.mockImplementationOnce(() => {
        // The generator has to be created lazily, after `query()` has actually been called, so it
        // can read `queryMock.mock.calls.at(-1)` for the real prompt this specific call received.
        let gen: AsyncGenerator<unknown> | undefined;
        return {
            [Symbol.asyncIterator]: () => {
                gen ??= fakeEngine(sessionId);
                return gen;
            },
            return: streamReturnMock,
        };
    });
};

const drain = async (gen: AsyncGenerator<string>): Promise<string[]> => {
    const chunks: string[] = [];
    for await (const chunk of gen) chunks.push(chunk);
    return chunks;
};

describe('PlanSessionAgent', () => {
    afterEach(() => {
        queryMock.mockReset();
        streamReturnMock.mockClear();
    });

    it('holds a single conversation across two turns: the second reply carries the first turn too', async () => {
        armQuery();
        const agent = new PlanSessionAgent({ worktreeRoot: '/tmp/worktree', model: 'claude-opus' });

        const first = await drain(agent.turn('remember the number 7'));
        expect(first[0]).toBe('part1[remember the number 7]');

        const second = await drain(agent.turn('what number did I say?'));
        expect(second[0]).toBe('part1[remember the number 7|what number did I say?]');

        // One engine call served both turns — the mechanism the conversation depends on.
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('yields assistant text as separate chunks as they are produced, not only once the turn completes', async () => {
        armQuery();
        const agent = new PlanSessionAgent({ worktreeRoot: '/tmp/worktree', model: 'claude-opus' });

        const chunks = await drain(agent.turn('hello'));

        expect(chunks).toEqual(['part1[hello]', 'part2']);
    });

    it("records the engine's session id once the stream reports one", async () => {
        armQuery('sess-xyz');
        const agent = new PlanSessionAgent({ worktreeRoot: '/tmp/worktree', model: 'claude-opus' });

        expect(agent.sessionId).toBeUndefined();
        await drain(agent.turn('hi'));

        expect(agent.sessionId).toBe('sess-xyz');
    });

    it('passes a resume option through to query() only when one was given', async () => {
        armQuery();
         
        new PlanSessionAgent({ worktreeRoot: '/tmp/worktree', model: 'claude-opus', resume: 'engine-session-77' });

        const options = (queryMock.mock.calls[0]?.[0] as { options: { resume?: string } }).options;
        expect(options.resume).toBe('engine-session-77');
    });

    it('never asks the engine to resume when no resume id was given', async () => {
        armQuery();
         
        new PlanSessionAgent({ worktreeRoot: '/tmp/worktree', model: 'claude-opus' });

        const options = (queryMock.mock.calls[0]?.[0] as { options: { resume?: string } }).options;
        expect(options.resume).toBeUndefined();
    });

    it('strips a provider API key out of the environment the engine runs with', async () => {
        const original = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'sk-should-not-reach-the-engine';
        try {
            armQuery();
             
            new PlanSessionAgent({ worktreeRoot: '/tmp/worktree', model: 'claude-opus' });

            const options = (queryMock.mock.calls[0]?.[0] as { options: { env: NodeJS.ProcessEnv } }).options;
            expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
            // The process's own environment must be untouched — only the copy handed to the engine is stripped.
            expect(process.env.ANTHROPIC_API_KEY).toBe('sk-should-not-reach-the-engine');
        } finally {
            if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
            else process.env.ANTHROPIC_API_KEY = original;
        }
    });

    /**
     * Card 0141: `options.configDir`, when given, reaches `query()`'s `env` as `CLAUDE_CONFIG_DIR`
     * via `subscriptionEnv` — this class has no DI and no store of its own, so the caller
     * (`PlanService.turn`) resolves the `claude-config-dir` setting and hands the result straight
     * in, the same way it already hands in `model`.
     */
    it('sets CLAUDE_CONFIG_DIR in the engine env when a configDir option is given', async () => {
        armQuery();

        new PlanSessionAgent({ worktreeRoot: '/tmp/worktree', model: 'claude-opus', configDir: '/home/operator/.claude-wilson' });

        const options = (queryMock.mock.calls[0]?.[0] as { options: { env: NodeJS.ProcessEnv } }).options;
        expect(options.env.CLAUDE_CONFIG_DIR).toBe('/home/operator/.claude-wilson');
    });

    it('carries no CLAUDE_CONFIG_DIR key at all when no configDir option is given', async () => {
        armQuery();

        new PlanSessionAgent({ worktreeRoot: '/tmp/worktree', model: 'claude-opus' });

        const options = (queryMock.mock.calls[0]?.[0] as { options: { env: NodeJS.ProcessEnv } }).options;
        expect('CLAUDE_CONFIG_DIR' in options.env).toBe(false);
    });

    it('carries no CLAUDE_CONFIG_DIR key at all when configDir is explicitly undefined', async () => {
        armQuery();

        new PlanSessionAgent({ worktreeRoot: '/tmp/worktree', model: 'claude-opus', configDir: undefined });

        const options = (queryMock.mock.calls[0]?.[0] as { options: { env: NodeJS.ProcessEnv } }).options;
        expect('CLAUDE_CONFIG_DIR' in options.env).toBe(false);
    });

    it('carries no report tool, no scope guard and no step, turn or wall-clock budget', async () => {
        armQuery();
         
        new PlanSessionAgent({ worktreeRoot: '/tmp/worktree', model: 'claude-opus' });

        const options = (
            queryMock.mock.calls[0]?.[0] as {
                options: {
                    mcpServers?: unknown;
                    canUseTool?: unknown;
                    maxTurns?: unknown;
                    maxBudgetUsd?: unknown;
                    abortController?: unknown;
                    permissionMode: string;
                };
            }
        ).options;

        expect(options.mcpServers).toBeUndefined();
        expect(options.canUseTool).toBeUndefined();
        expect(options.maxTurns).toBeUndefined();
        expect(options.maxBudgetUsd).toBeUndefined();
        expect(options.abortController).toBeUndefined();
        // No terminal is on the other end of an HTTP turn to answer a permission prompt.
        expect(options.permissionMode).toBe('bypassPermissions');
    });

    it('tears the engine stream down on dispose', async () => {
        armQuery();
        const agent = new PlanSessionAgent({ worktreeRoot: '/tmp/worktree', model: 'claude-opus' });

        agent.dispose();

        expect(streamReturnMock).toHaveBeenCalledTimes(1);
    });
});
