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
 * A bucket of the plan's Tasks-section items the scope-check stage judges to be "the same kind of
 * thing" — card 0105's calibration finding: breadth (how many times a plan repeats one kind of
 * work), not file count or plan length, is what predicts a card too big for one pass. Every item in
 * the Tasks section belongs to exactly one group: a plan doing three different things once each
 * reports three groups of size one; a plan doing the same thing eight times reports one group of
 * size eight (card 0075: eight near-identical endpoints) or one of any other size (card 0078: every
 * CLI command ported). `title` names the kind, `tasks` are that group's members, quoted or numbered
 * from the plan so a human can find them.
 */
export const ScopeGroupSchema = z.object({
    title: z.string().describe('What kind of work this group is — the label under which its tasks repeat.'),
    tasks: z.array(z.string()).min(1).describe("Which Tasks-section items belong to this group — quote or number them."),
});

/**
 * One piece of a proposed division, reported only when the verdict is "refuse".
 *
 * Not itself a split — dividing a card is `planning`'s decision (card 0105's Goal) — but concrete
 * enough that a human or `wilson card plan` has seams to start from instead of "this card is too
 * large". `delivers` is what makes a piece a piece rather than an arbitrary file list: it must stand
 * on its own. `dependsOn` is the third thing card 0105's Constraints requires the refusal to name —
 * "which tasks group together, what each piece would deliver on its own, what depends on what" — kept
 * optional and defaulted to `[]` so a division where every piece is independent (the common case)
 * costs the model nothing extra to report.
 */
export const ScopeDivisionPieceSchema = z.object({
    title: z.string().describe('A short name for this piece.'),
    tasks: z.array(z.string()).min(1).describe('Which Tasks-section items this piece would carry.'),
    delivers: z.string().describe('What this piece would deliver on its own, if built alone.'),
    dependsOn: z
        .array(z.string())
        .default([])
        .describe(
            'Titles of other pieces in this same division that must land first, if any — by piece title. Empty when this piece can be built independently of the rest.',
        ),
});

/**
 * What the scope-check stage reports: every Tasks-section item bucketed by kind (`groups`, always
 * present — the breadth evidence), a verdict, why in terms of repetition, and — only when refusing —
 * a concrete division.
 *
 * `verdict` drives `ScopeCheckVerifier.passed` directly rather than following `ReviewResultSchema`'s
 * pattern of a `passed`/`verdict` split resolved later by `shouldAdvance` (`kickback.ts`):
 * `shouldAdvance` only special-cases the literal string `"revise"`, which is review's own routing
 * signal, and `kickback.ts` is out of this card's scope to extend for a second one. Since this
 * stage's `onPass`/`onFail` point to different destinations (`implementing` vs `planning`, unlike
 * review's shared `onFail`), folding the verdict into `passed` is not a workaround here — it is
 * this stage's actual exit condition: "is this card small enough for one pass", full stop.
 */
export const ScopeCheckResultSchema = z
    .object({
        summary: z.string(),
        groups: z
            .array(ScopeGroupSchema)
            .min(1)
            .describe(
                'Every item in the plan’s Tasks section, bucketed by "the same kind of thing" — one entry per distinct kind of work, however many tasks share it.',
            ),
        verdict: z.enum(['pass', 'refuse']),
        reason: z
            .string()
            .describe(
                'Why, stated in terms of repetition: name the kind of work and how many times it repeats. Never file count or plan length — those do not predict it (card 0105).',
            ),
        division: z.array(ScopeDivisionPieceSchema).default([]),
    })
    .refine(result => result.verdict !== 'refuse' || result.division.length >= 2, {
        message: 'a "refuse" verdict must propose a division of at least two pieces',
        path: ['division'],
    });

export type ScopeGroup = z.infer<typeof ScopeGroupSchema>;
export type ScopeDivisionPiece = z.infer<typeof ScopeDivisionPieceSchema>;
export type ScopeCheckResult = z.infer<typeof ScopeCheckResultSchema>;

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
    /**
     * Set on a failing, `unjudged` outcome when the stage did call its report tool but the result
     * never reached the runner — a transport loss, not a stage that stopped early. `unjudged` still
     * routes the retry back to this stage the same way either way (see its own doc comment), but
     * `kickback` charges the two differently: this one gets a small free allowance before it starts
     * spending `retries[stage.name]` like a genuine failure (`kickback.ts`, `RESULT_DROPPED_ALLOWANCE`).
     * Carried straight from `AgentRunOutput.resultDropped` (`stage.agent.ts`); only the `cli` adapter
     * can ever set it.
     */
    resultDropped?: boolean;
}
