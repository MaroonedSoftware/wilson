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

/**
 * What a finding is about, which decides how the runner can check it is real.
 *
 * `defect` is a claim about code the card wrote: it must cite a path from the diff and a line that
 * exists there. `omission` is a claim about work the card did *not* do, which by construction has no
 * line in the diff to point at — the file is named because that is where the missing work belongs.
 *
 * Without the distinction, a true finding is inexpressible. Card 0015's review correctly spotted
 * that a value was never wired into the dispatcher, cited the dispatcher, and had its whole result
 * rejected because that file is not in the diff — precisely because the wiring was missing.
 */
export const ReviewFindingKind = z.enum(['defect', 'omission']);

export const ReviewFindingSchema = z
    .object({
        severity: z.enum(['blocker', 'concern']),
        kind: ReviewFindingKind.default('defect'),
        file: z.string().describe('For a defect, a path from this card’s diff. For an omission, the file where the missing work belongs.'),
        line: z.number().int().min(1).optional().describe('A line number in that file. Required for a defect, omitted for an omission.'),
        problem: z.string().describe('What is wrong, in one sentence.'),
        suggestion: z.string().describe('What would fix it, in one sentence.'),
    })
    .refine(finding => finding.kind !== 'defect' || finding.line !== undefined, {
        message: 'a defect must cite a line; use kind "omission" for work that was not done',
        path: ['line'],
    });

export const ReviewResultSchema = z.object({
    summary: z.string(),
    verdict: z.enum(['pass', 'revise']),
    findings: z.array(ReviewFindingSchema).max(20),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/**
 * Stage name (or its `verifier` override) -> the schema its report tool enforces.
 *
 * Registered in `StagesModule` the same way `StageVerifierMap` is, so `buildTools` never hardcodes
 * one stage's shape for every stage.
 */
export class StageResultSchemaMap extends Map<string, z.ZodTypeAny> {}

export interface StageOutcome {
    passed: boolean;
    /** Why the exit condition failed, in the order the checks ran. */
    failures: string[];
    changedPaths: string[];
    scopeGrants: string[];
    result?: unknown;
    usage?: { inputTokens?: number; outputTokens?: number };
    /** Where the runner moved the card after this stage, when it moved it at all. */
    transitionedTo?: string;
    /** Whether this transition flagged the card for a human. `decideChain` checks this before re-enqueuing. */
    needsHuman?: boolean;
    /**
     * Set on a failing outcome when the failure says nothing about the code: a step, wall-clock or
     * token budget cutoff, an engine that stopped responding, a run that never called the report
     * tool, or a result that never parsed against the stage's own schema. None of those is a verdict
     * on what the stage produced — there was nothing coherent to judge. Unset (or `false`) when a
     * verifier actually evaluated the work and rejected it, or when the stage passed.
     *
     * `kickback` (`kickback.ts`) uses this to route the retry back to this stage instead of wherever
     * `onFail` points — see its doc comment for why the distinction has to live here, in the run's
     * own outcome, rather than in `kickback` itself.
     */
    unjudged?: boolean;
}
