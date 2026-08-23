import type { ToolContext } from './tools/index.js';
import type { StageConfig } from '#modules/stages/stage.config.js';

export interface AgentRunInput {
    stage: StageConfig;
    context: ToolContext;
    /** Absolute path to the card's plan, outside the worktree. */
    planPath: string;
    /** The card's title, for the prompt. */
    title: string;
    /** Zod schema the stage's result must satisfy. */
    resultSchema: unknown;
}

export interface AgentRunOutput {
    /** What the agent reported, or undefined when it never reported finishing. */
    result?: unknown;
    /** Cumulative usage, as far as the adapter can report it. */
    usage?: { inputTokens?: number; outputTokens?: number };
    /** True when the loop was cut off rather than ending because the agent finished. */
    truncated: boolean;
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
