import type { BlockedReport } from '#modules/agent/blocked.report.js';
import type { TreeSnapshot } from '#modules/worktree/worktree.manager.js';
import { z } from 'zod';
import type { RunTrace } from '#modules/agent/run.trace.js';

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

/**
 * Whether a review accounted for one acceptance criterion from the pinned plan: checked it and
 * found it done (`met`), checked it and found it not done (`unmet`), or could not check it at all
 * (`unverifiable`) — the plan asked for something the diff cannot settle either way, e.g. a manual
 * QA step. `unmet` is deliberately not folded into `findings`: a criterion is identified by the
 * plan's own ID, not discovered by the reviewer the way a defect or omission is, and the runner's
 * provenance check (`ReviewVerifier`) needs that ID to reconcile against `acceptanceCriteria(card)`.
 */
export const ReviewCriterionStatus = z.enum(['met', 'unmet', 'unverifiable']);

export const ReviewCriterionSchema = z
    .object({
        id: z.string().describe('The criterion’s ID from the plan’s Acceptance criteria section, e.g. "AC2".'),
        status: ReviewCriterionStatus,
        file: z.string().optional().describe('For status "met", a path from this card’s diff that satisfies the criterion.'),
        line: z.number().int().min(1).optional().describe('For status "met", a line in that file. Required when status is "met".'),
        note: z.string().describe('Why this status — what was checked, or why it could not be checked.'),
    })
    .refine(criterion => criterion.status !== 'met' || (criterion.file !== undefined && criterion.line !== undefined), {
        message: 'a "met" criterion must cite a file and line',
        path: ['file'],
    });

export type ReviewCriterion = z.infer<typeof ReviewCriterionSchema>;

export const ReviewResultSchema = z.object({
    summary: z.string(),
    verdict: z.enum(['pass', 'revise']),
    findings: z.array(ReviewFindingSchema).max(20),
    /**
     * Defaults to `[]` so a plan with no acceptance criteria bullets, and a result reported before
     * this field existed, both still parse — `ReviewVerifier` skips its whole criteria check on an
     * empty plan-side list, matching what a review verified before this field existed.
     */
    criteria: z.array(ReviewCriterionSchema).default([]),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/**
 * One incoming blocker the challenge stage decided does not hold.
 *
 * `problem` is matched back to the review finding it refutes by `ChallengeVerifier`'s own
 * whitespace-normalised, case-folded comparison — not by `file`/`line`, which can shift between the
 * review run and the challenge run once the dispatcher rebases the card's branch onto head. `reason`
 * is why: an empty one is indistinguishable from a blocker the model skipped rather than refuted, so
 * `ChallengeVerifier` rejects it the same way a missing refutation is rejected.
 */
export const RefutedFindingSchema = z.object({
    problem: z.string().describe('The blocker’s `problem` text, verbatim from the review finding being refuted.'),
    reason: z.string().describe('Why this blocker does not hold, citing the diff or the plan.'),
});

export type RefutedFinding = z.infer<typeof RefutedFindingSchema>;

/**
 * What the challenge stage reports: `ReviewResultSchema` extended with `refuted`, the incoming
 * blockers it talked itself out of.
 *
 * `findings` carries the upheld blockers plus the incoming concerns, unchanged — challenge does not
 * touch concerns (only blockers are challenged); `ChallengeVerifier` does not verify that concerns
 * survive untouched, only that every incoming *blocker* is accounted for. `verdict` follows `findings`
 * the same way it does in `ReviewResultSchema`: `'revise'` iff a blocker survived.
 */
export const ChallengeResultSchema = ReviewResultSchema.extend({
    refuted: z.array(RefutedFindingSchema).default([]),
});

export type ChallengeResult = z.infer<typeof ChallengeResultSchema>;

/**
 * A bucket of the plan's Tasks-section items the scope-check stage judges to be "the same kind of
 * thing" — card 0105's calibration finding: breadth (how many times a plan repeats one kind of
 * work), not file count or plan length, is what predicts a card too big for one pass. Every item in
 * the Tasks section belongs to exactly one group: a plan doing three different things once each
 * reports three groups of size one; a plan doing the same thing eight times reports one group of
 * size eight (card 0075: eight near-identical endpoints) or one of any other size (card 0078: every
 * CLI command ported). `title` names the kind, `tasks` are that group's members, quoted or numbered
 * from the plan so a human can find them.
 *
 * `sites` is a second, independent count of the same group's fan-out: how many distinct places —
 * files, call sites, routes — its work actually lands, as opposed to how many Tasks-section items
 * describe it. The two diverge exactly where breadth (which reads `tasks.length`) goes blind: a
 * single task that says "update every internal link" or "migrate every importer of lib/sdk.ts" is
 * one entry in `tasks` no matter how many files it touches, but card 0158's whole reason for
 * existing is that the model already knows the real number and, before this field, had nowhere
 * checkable to put it — cards 0153, 0155 and 0156 named it in `reason` prose instead ("roughly 10
 * files", "~8 route files"), which a verifier cannot check.
 */
export const ScopeGroupSchema = z.object({
    title: z.string().describe('What kind of work this group is — the label under which its tasks repeat.'),
    tasks: z.array(z.string()).min(1).describe('Which Tasks-section items belong to this group — quote or number them.'),
    sites: z
        .number()
        .int()
        .min(1)
        .describe(
            "How many distinct places in the codebase this group's work actually lands — files, call sites, routes — not " +
                'how many Tasks-section items describe it. A task like "update every internal link" is one entry in `tasks` ' +
                'but may land in ten files: report the ten.',
        ),
});

/**
 * One piece of a proposed division, reported only when the verdict is "refuse".
 *
 * Not itself a split: that takes an operator confirming it, or `AUTO_SPLIT_ENABLED` being on for the
 * project (`AutoSplitter`). Concrete enough either way that a human or `wilson card plan` has seams to
 * start from instead of "this card is too large". `delivers` is what makes a piece a piece rather than an arbitrary file list: it must stand
 * on its own. `dependsOn` is the third thing card 0105's Constraints requires the refusal to name —
 * "which tasks group together, what each piece would deliver on its own, what depends on what" — kept
 * optional and defaulted to `[]` so a division where every piece is independent (the common case)
 * costs the model nothing extra to report.
 */
export const ScopeDivisionPieceSchema = z.object({
    title: z.string().describe('A short name for this piece.'),
    tasks: z.array(z.string()).min(1).describe('Which Tasks-section items this piece would carry — cite them the way `groups` does.'),
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
 * present — the breadth, depth and fan-out evidence, the last from each group's own `sites`), a
 * verdict, why in terms of repetition, and — only when refusing — a concrete division.
 *
 * Unlike `ReviewResultSchema`'s `passed`/`verdict` split — resolved later by `shouldAdvance`
 * (`kickback.ts`), which special-cases the literal string `"revise"` (review's own routing signal) —
 * this schema has no `passed` field of its own for the dispatcher to read: `StageDispatcher.runAgent`
 * computes its routing-relevant `outcome.passed` from `failures.length === 0` alone, and
 * `shouldAdvance` never special-cases `"refuse"`. So `ScopeCheckVerifier.verify` (`kickback.ts` is out
 * of this card's scope to extend for a second verdict string) turns a `"refuse"` verdict into a
 * pushed failure itself, making the dispatcher's own check the thing that actually routes a refusal
 * to `planning` instead of `implementing`. See `ScopeCheckVerifier`'s class doc comment for the detail.
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

/** A scope-check refusal the verifier believed: why, and the pieces the model proposed. */
export interface SupportedRefusal {
    reason: string;
    division: z.infer<typeof ScopeDivisionPieceSchema>[];
}

/**
 * Why a stage failed, as a word to count by. `verifier` is the one judgment about the work. Every other
 * class says the stage did not finish or its report could not be used, so it says nothing about the code.
 * The {@link PROCESS_FAILURE_CLASSES} say the process failed rather than the stage, so they hold the
 * card without spending its retries.
 */
export type FailureClass =
    /** A verifier's own check failed: the work, not the run. */
    | 'verifier'
    /** A review or challenge was rejected only for a fault in its own report. */
    | 'reportRejected'
    /** The result did not parse against the stage's own schema. */
    | 'schemaInvalid'
    /** The stage ended without calling its report tool. */
    | 'noReport'
    /** The stage called its report tool and the result never arrived. */
    | 'resultDropped'
    /** A step, wall-clock, token or context cap cut the run off. */
    | 'budget'
    /** The engine stopped responding, or never started. */
    | 'engine'
    /** The model API refused the engine's request with a client error, which a retry would repeat. */
    | 'engineApi'
    /** The host the stage ran on stopped answering. `CardStageJob` sends it again later, then flags it. */
    | 'hostLost'
    /** The run was stopped for repeating the same tool call. */
    | 'loop'
    /** The stage threw before it reached an outcome. */
    | 'error';

/**
 * Failures of the process around the stage rather than of the stage: no attempt at the card's work was
 * made, so none is charged to it. `engineApi` holds the card for a person (`StageOutcome.processFailure`);
 * `hostLost` sends the stage again with a growing delay and flags it after `MAX_HOST_LOSSES`.
 */
export const PROCESS_FAILURE_CLASSES: ReadonlySet<string> = new Set<FailureClass>(['engineApi', 'hostLost']);

/** The longest `reason` an event carries. The whole text stays in `failures`, or on the card. */
export const REASON_LIMIT = 500;

/** What a failed run knew about itself, in the order the failures it writes lead with. */
export const failureClassOf = (signals: {
    engineApiError?: string;
    engineFailure?: string;
    budgetFailure?: string;
    truncated?: boolean;
    resultDropped?: boolean;
    noReport: boolean;
    schemaInvalid: boolean;
    reportRejected?: boolean;
}): FailureClass => {
    if (signals.engineApiError) return 'engineApi';
    if (signals.engineFailure) return 'engine';
    if (signals.budgetFailure || signals.truncated) return 'budget';
    if (signals.resultDropped) return 'resultDropped';
    if (signals.noReport) return 'noReport';
    if (signals.schemaInvalid) return 'schemaInvalid';
    if (signals.reportRejected) return 'reportRejected';
    return 'verifier';
};

export interface StageOutcome {
    /** The question the stage stopped to ask. Not a failure: nothing was judged, and no retry is spent. */
    blocked?: BlockedReport;
    /** A step of the lane the card stays in to run next, with `transitionedTo` naming that lane. */
    nextStep?: string;
    passed: boolean;
    /** Why the exit condition failed, in the order the checks ran. */
    failures: string[];
    changedPaths: string[];
    scopeGrants: string[];
    /** What was uncommitted when the verifier finished, which is what its verdict is about. */
    verifiedTree?: TreeSnapshot;
    result?: unknown;
    usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number };
    /** The engine account `usage` was spent on, as `AgentRunOutput.account` names it. */
    account?: string;
    /**
     * `VerificationOutcome.supportedRefusal`, carried only when the run itself added no failure of
     * its own: a truncated or budget-cut run's report is not one to act on, whatever it said.
     */
    supportedRefusal?: SupportedRefusal;
    /** The pieces this stage's automatic split created, for `CardStageJob` to have drafted. */
    splitInto?: string[];
    /** Blockers a challenge upheld and that sent the card back, for `CardStageJob` to have looked at for a rule. */
    upheldBlockers?: ReviewFinding[];
    /** Where the runner moved the card after this stage, when it moved it at all. */
    transitionedTo?: string;
    /** The run was cut off rather than finishing. Absent otherwise. */
    truncated?: boolean;
    /** Every failure was a fault in the stage's own report, not a statement about the code. Absent otherwise. */
    reportRejected?: boolean;
    /** Whether this transition flagged the card for a human. `decideChain` checks this before re-enqueuing. */
    needsHuman?: boolean;
    /** The verifier's `needsHumanReason`: flag the card with this, whatever retries it has left. */
    needsHumanReason?: string;
    /**
     * Set on a failing outcome the process caused rather than the stage (a `PROCESS_FAILURE_CLASSES`
     * class): why the card is held. `writeTransition` flags the card with this and leaves its retries
     * as they were, since the stage never got to attempt the work and a retry would fail the same way.
     */
    processFailure?: string;
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
    /**
     * Set on a failing, `unjudged` outcome when the run was stopped for repeating the same tool call
     * (`AgentRunOutput.loopFailure`). The one unjudged failure that writes an attempt bullet: the next
     * attempt starts in a fresh session, and left unwarned it would be free to walk into the same loop.
     */
    loopStopped?: boolean;
    /** Why a failing outcome failed. Absent on a pass and on a question. */
    failureClass?: FailureClass;
    /**
     * The engine's own account of why its last message ended, carried straight from
     * `AgentRunOutput.engineStopReason` (`stage.agent.ts`) — see that field's doc comment for exactly
     * what it can and cannot say. `StageDispatcher` puts this on `stage.failed` alongside `failures`
     * and `usage` (card 0118) rather than a new event, so a pass that produced nothing says why
     * without changing what happens next: this is evidence attached to the existing failure, not a
     * routing signal — `kickback`/`shouldAdvance` never read it. Unset on a passing outcome.
     */
    engineStopReason?: string;
    /** `AgentRunOutput.trace`, for the stage's end event. */
    trace?: RunTrace;
}
