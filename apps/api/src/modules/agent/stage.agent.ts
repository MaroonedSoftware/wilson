import type { BlockedReport } from './blocked.report.js';
import type { RunTrace } from './run.trace.js';
import type { UsageLimit } from './usage.limit.js';
import type { ToolContext } from './tools/index.js';
import type { StageConfig } from '#modules/stages/stage.config.js';

/**
 * One of the card's attached images, as a stage run sees it (card 0010).
 *
 * `bytes` travels with the path so no adapter has to import `node:fs` to read it back, and so the
 * bytes are read from the database once per run: the `api` adapter hands them to the model as an
 * image part, since its own `read` tool is UTF-8 text only. The `cli` and `codex` adapters name
 * `path` instead.
 */
export interface StageAttachment {
    /** Absolute path, on the machine the agent's tools run on — the host's, on a placed stage. */
    path: string;
    /** The sanitised display name, which is what a plan cites. */
    filename: string;
    /** The type sniffed from the bytes when the image was uploaded. */
    contentType: string;
    bytes: Buffer;
}

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
    /**
     * The card's attached images (card 0010), written by `StageDispatcher.run` to
     * `<runRoot>/cards/<cardId>/attachments/` beside `planPath` — outside the worktree for the same
     * reason the plan is, so no image can ever be committed to the card's branch or show up in its
     * diff. On a placed stage each `path` is the host's copy under the host's run root, as `planPath`
     * already is there.
     *
     * Unset and `[]` both mean "no images": an adapter must then add no prompt line about images at
     * all, the same rule `learningsPath` follows for an absent document. Optional for the reason
     * `learningsPath` is — dozens of tests build this input as a literal.
     */
    attachments?: readonly StageAttachment[];
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
    /**
     * Set when this run picks up a tree an interrupted attempt left, and `sessionId` when there is a
     * conversation to continue. Only the `cli` and `codex` adapters can be interrupted, so only they read this.
     */
    resume?: { sessionId?: string };
}

export interface AgentRunOutput {
    /** What the agent reported, or undefined when it never reported finishing. */
    result?: unknown;
    /**
     * Cumulative usage, as far as the adapter can report it. `inputTokens` leaves out what the cache
     * served or stored; `cachedInputTokens` is that, reads plus writes; `cacheWriteInputTokens` is how
     * many of those were writes, absent where the engine reports only reads (`codex`).
     */
    usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number };
    /**
     * The engine account `usage` was spent on: a saved token's name, `local`, `worker:<host>` or
     * `codex:<host>`, as `EngineAccountsService` names them. Absent for an adapter that signs in with
     * no engine account, such as `api`.
     */
    account?: string;
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
     * Set when the run was stopped for repeating the same tool call (`RepeatedCallWatch`), naming the
     * call. Neither a budget nor the engine was at fault, so an operator has no cap to raise, and the
     * run never reported, so the dispatcher has nothing to verify.
     */
    loopFailure?: string;
    /**
     * Set when the run ended because its account hit a usage limit, which says nothing about the card.
     * Comes with `interrupted`, which says where to pick up, and `heldUntil`, which says when.
     */
    usageLimit?: UsageLimit;
    /**
     * When the stage can run again, in milliseconds since the epoch: now if another account is free,
     * and otherwise when the first one resets. Set with `usageLimit`.
     */
    heldUntil?: number;
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
     * Set when the stage stopped to ask a person a question (`report_blocked`). The run ended there,
     * so there is nothing to verify: the dispatcher parks the card until someone answers.
     */
    blocked?: BlockedReport;
    /**
     * Set when `StageInterrupt` or the loss of the run's host stopped it, which says nothing about the
     * stage itself. `hostLost` is why the host went, when that is what stopped it.
     */
    interrupted?: { sessionId?: string; wallClockMs: number; steps: number; hostLost?: string };
    /** The engine could not continue `AgentRunInput.resume`'s session. Never leaves `CliStageAgent`. */
    resumeFailed?: boolean;
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
 * Chosen per stage by config. `codex` drives OpenAI's Codex engine (`codex.stage.agent.ts`). `api` drives the AI SDK's ToolLoopAgent against
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

/** DI token: adapter name (`api`, `cli`, `codex`) → implementation. */
export class StageAgentMap extends Map<string, StageAgent> {}
