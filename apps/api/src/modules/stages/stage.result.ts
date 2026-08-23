import { z } from 'zod';

/**
 * What a stage returns.
 *
 * Every stage writes a machine-readable result (PROJECT.md, Structured output) — prose in stdout is
 * not a stage result. Enforced through the AI SDK's `Output.object`, so the model retries on a
 * mismatch instead of the runner parsing free text.
 */
export const ImplementingResultSchema = z.object({
    summary: z.string().describe('One or two sentences on what was changed and why.'),
    filesTouched: z.array(z.string()).describe('Worktree-relative paths that were created or modified.'),
    /** Where the agent knows it fell short. Recorded for the review stage rather than acted on here. */
    caveats: z.array(z.string()).default([]),
});

export type ImplementingResult = z.infer<typeof ImplementingResultSchema>;

/** The verdict shape the plan-review stage will emit at step 5. Defined now so the enum is shared. */
export const FindingSeverity = z.enum(['blocker', 'concern']);

export interface StageOutcome {
    passed: boolean;
    /** Why the exit condition failed, in the order the checks ran. */
    failures: string[];
    changedPaths: string[];
    scopeGrants: string[];
    result?: unknown;
    usage?: { inputTokens?: number; outputTokens?: number };
}
