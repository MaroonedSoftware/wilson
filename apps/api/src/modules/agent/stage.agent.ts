import type { RunTrace } from './run.trace.js';
import type { ToolContext } from './tools/index.js';
import type { StageConfig } from '#modules/stages/stage.config.js';

export interface AgentRunInput {
    stage: StageConfig;
    context: ToolContext;
    /** Absolute path to the card's plan, outside the worktree. */
    planPath: string;
    /**
     * Absolute path to the project's learnings document, outside the worktree — present only when
     * `StageDispatcher.run` found the document non-empty (card 0244). An empty or absent document
     * means "no learnings" (PROJECT.md decision 8), so this is left unset rather than pointed at a
     * file with nothing in it; an adapter must add no prompt line at all when this is unset, the
     * same way it says nothing about a card with no preserved patch.
     */
    learningsPath?: string;
    /** The card's title, for the prompt. */
    title: string;
    /** Zod schema the stage's result must satisfy. */
    resultSchema: unknown;
    /**
     * The worktree's fork point (`Worktree.baseSha`) — the one basis every verifier measures the
     * card's diff against, and the sha `git diff <baseSha>` must be run against to reproduce it.
     * Prompt material, like `title` and `planPath`: `ToolContext` stays narrow on purpose, and no
     * tool reads this, so it does not belong there. Named in both adapters' prompts so a stage that
     * needs to look at its own diff — testing and review chief among them — is told the sha rather
     * than left to guess `git diff main` or `git diff HEAD~1`, either of which lies the moment
     * `main` has moved since the branch was cut.
     */
    baseSha: string;
}

export interface AgentRunOutput {
    /** What the agent reported, or undefined when it never reported finishing. */
    result?: unknown;
    /** Cumulative usage, as far as the adapter can report it. */
    usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
    /** True when the loop was cut off rather than ending because the agent finished. */
    truncated: boolean;
    /**
     * Set when a run's budget was exceeded — input tokens meeting `maxInputTokens`, or the run being
     * aborted for exceeding `maxWallClockMs` — naming which cap and, where known, the actual figure.
     */
    budgetFailure?: string;
    /**
     * Set when the run was abandoned because the engine stopped responding rather than because it
     * spent something. Kept separate from `budgetFailure` so an operator is not sent to raise a cap
     * that was never the problem, and so the caller does not also blame the step budget.
     */
    engineFailure?: string;
    /**
     * Set when `result` above is undefined but a `report_result` tool call was seen on the stream
     * anyway: the stage did the whole job and the transport lost the result on the way back, rather
     * than the stage never finishing at all. Distinct from `result` being undefined with this unset,
     * which means the report tool was never called. Only `cli.stage.agent.ts` can tell the two apart,
     * since only it watches the raw stream for the tool call — the `api` adapter has no equivalent
     * (card 0092: out of scope).
     */
    resultDropped?: boolean;
    /**
     * The engine's own account of why its last message ended, when it said anything at all — the
     * SDK `result` message's `subtype` and `stop_reason` (card 0118). Only `cli.stage.agent.ts` can
     * set this: it is the only adapter that reads `query()`'s raw stream, and it is the SDK's own
     * words, not this runner's inference — see `describeEngineStop` there for exactly which of a
     * run's several ways of ending get one and which do not.
     *
     * Unset on an ordinary pass, and also unset on a run that ended without a `result` message ever
     * arriving (the runner's own wall-clock/idle timeout firing first, or the stream simply closing)
     * — in both of those the SDK told this adapter nothing, and this field says nothing rather than
     * guess.
     */
    engineStopReason?: string;
    /** What the run read and last said, for reading its attempt back later. */
    trace?: RunTrace;
}

/**
 * How a stage's agent is run.
 *
 * Two implementations, chosen per stage by config. `api` drives the AI SDK's ToolLoopAgent against
 * a provider API key. `cli` drives the Claude Code engine through @anthropic-ai/claude-agent-sdk,
 * which authenticates from the operator's own Claude Code credentials — no API key, no per-token
 * billing.
 *
 * The seam exists because those two things fail independently. An exhausted API balance stops every
 * `api` stage and leaves `cli` untouched; a logged-out workstation does the reverse. PROJECT.md
 * called for a `cli` escape hatch from the start; this is it, built the day the API credits ran out.
 */
export abstract class StageAgent {
    abstract run(input: AgentRunInput): Promise<AgentRunOutput>;
}

/** DI token: adapter name (`api`, `cli`) → implementation. */
export class StageAgentMap extends Map<string, StageAgent> {}
