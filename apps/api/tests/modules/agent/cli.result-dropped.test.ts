import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0092. `CliStageAgent.run` watches the raw stream for a `report_result` tool_use block so it
 * can tell "the stage never called the report tool" apart from "the stage called it and the result
 * never reached the callback" — the transport dropping the call is not the same failure as the stage
 * never finishing, and `stage.dispatcher.ts`/`kickback.ts` treat the two differently (card 0092).
 *
 * `query` is mocked the same way the other cli adapter suites mock it: the real engine never invokes
 * the MCP tool's own handler in these tests (the mocked `createSdkMcpServer`/`tool` never wire the
 * handler up to anything that could call it), so `reported` stays `undefined` regardless of what the
 * stream carries — which is exactly what lets these tests isolate the new stream-watching behaviour
 * from the handler that sets `reported` on a real run.
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

/** An assistant message carrying a `report_result` tool_use block, the way the engine emits one. */
const reportToolUseMessage = {
    type: 'assistant',
    message: {
        content: [{ type: 'tool_use', name: 'mcp__wilson__report_result', id: 'toolu_1', input: { summary: 'did the thing' } }],
    },
};

/** An assistant message carrying only prose — no tool call at all. */
const proseOnlyMessage = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'still working on it' }] },
};

const successResult = { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } };
const maxTurnsResult = { type: 'result', subtype: 'error_max_turns', usage: { input_tokens: 10, output_tokens: 5 } };

describe('CliStageAgent — resultDropped (card 0092)', () => {
    afterEach(() => {
        queryMock.mockReset();
    });

    it('flags resultDropped when the report tool was called on the stream but the run still ends with no result', async () => {
        queryMock.mockReturnValue(streamOf([reportToolUseMessage, successResult]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as { result?: unknown; resultDropped?: boolean; truncated: boolean };

        // The mocked MCP handler never runs, so the callback that would set `reported` never fires —
        // this is exactly the shape a dropped result has to have: the tool was seen, but no result.
        expect(output.result).toBeUndefined();
        expect(output.resultDropped).toBe(true);
        expect(output.truncated).toBe(false);
    });

    it('does not flag resultDropped when the report tool is never seen on the stream at all', async () => {
        queryMock.mockReturnValue(streamOf([proseOnlyMessage, successResult]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as { result?: unknown; resultDropped?: boolean };

        expect(output.result).toBeUndefined();
        expect(output.resultDropped).toBeFalsy();
    });

    it('still flags resultDropped on the truncated path — a run that also ran out of turns after calling report', async () => {
        queryMock.mockReturnValue(streamOf([reportToolUseMessage, maxTurnsResult]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as { resultDropped?: boolean; truncated: boolean };

        expect(output.truncated).toBe(true);
        expect(output.resultDropped).toBe(true);
    });

    it('flags resultDropped on the fallback path when the stream ends silently after the tool call was seen', async () => {
        // No `result` message at all — the stream just closes. This exercises the final `output`
        // built after the read loop, not the `result`-message or timeout branches.
        queryMock.mockReturnValue(streamOf([reportToolUseMessage]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as { result?: unknown; resultDropped?: boolean; truncated: boolean };

        expect(output.result).toBeUndefined();
        expect(output.resultDropped).toBe(true);
        expect(output.truncated).toBe(false);
    });

    it('stays sticky: a report tool call seen early is not erased by a later prose-only message', async () => {
        queryMock.mockReturnValue(streamOf([reportToolUseMessage, proseOnlyMessage, successResult]));
        const agent = new CliStageAgent(silentLogger as never);

        const output = (await agent.run(runInput(makeStage()) as never)) as { resultDropped?: boolean };

        expect(output.resultDropped).toBe(true);
    });
});
