import { z } from 'zod';
import { ReviewResultSchema, type ReviewFinding } from '#modules/stages/stage.result.js';

/**
 * Scoring for the review measurement (`scripts/review.eval.ts`). Pure, so a number in a report can be
 * traced to a rule with a test behind it rather than to whatever the runner happened to do.
 *
 * Only the location is checked: a finding on the seeded lines counts whether or not it describes the
 * seeded defect, because judging that would take another model and another thing to measure. Each
 * match keeps its text in the results file, so a person can read what was counted.
 */

/** What a case's `truth.json` holds. The reviewer never sees it. */
export const ReviewEvalTruthSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('defect'),
        /** What sort of mistake this is, for the per-class breakdown. */
        class: z.string().min(1),
        /** Repository-relative, as `git diff` names it. */
        file: z.string().min(1),
        /** First and last line of the defect in the file after the patch, inclusive. */
        lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).refine(([first, last]) => first <= last, 'lines run first to last'),
        /** What is wrong, for a person reading the corpus. */
        about: z.string().min(1),
        /** The commit that later fixed it, which is the evidence it was a defect. */
        fixedBy: z.string().regex(/^[0-9a-f]{40}$/),
    }),
    z.object({
        kind: z.literal('control'),
        /** Why this diff is believed clean. No later fix is the evidence, not proof. */
        about: z.string().min(1),
    }),
]);

export type ReviewEvalTruth = z.infer<typeof ReviewEvalTruthSchema>;

/** The schema's own limit on findings. A review at the limit may have had more to say. */
export const FINDINGS_CAP = 20;

/** What `ReviewVerifier` said about a result, as far as scoring needs it. */
export interface ReviewEvalVerification {
    passed: boolean;
    failures: string[];
    changedPaths: string[];
}

/** One reading of a review's result: what the model reported, or what the runner would act on. */
export interface ReviewView {
    /** The result does not count: it never parsed, or the verifier refused it. */
    rejected: boolean;
    verdict?: 'pass' | 'revise';
    findings: ReviewFinding[];
}

/** One case's run. Without `unscored`, `reported` holds the model's result. */
export interface ReviewEvalRun {
    caseId: string;
    truth: ReviewEvalTruth;
    reported?: unknown;
    verification?: ReviewEvalVerification;
    /** Why this run says nothing about the review: the engine failed, or it hit a budget. */
    unscored?: string;
    /** The account ran out, so every case after this one would stop the same way. */
    outOfUsage?: boolean;
    durationMs?: number;
    usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number };
}

const rejectedView: ReviewView = { rejected: true, findings: [] };

/** The result as the model reported it, before the verifier has looked at it. */
export const rawView = (reported: unknown): ReviewView => {
    const parsed = ReviewResultSchema.safeParse(reported);
    if (!parsed.success) return rejectedView;
    return { rejected: false, verdict: parsed.data.verdict, findings: parsed.data.findings };
};

/**
 * The result as the runner would act on it. A result the verifier refuses counts for nothing. A
 * `defect` citing a real file outside the diff passes the verifier as an `omission`, which it says in
 * a log line and not on the finding, so that relabelling is applied here: as an omission its line
 * stops mattering.
 */
export const verifiedView = (reported: unknown, verification: ReviewEvalVerification | undefined): ReviewView => {
    if (!verification?.passed) return rejectedView;
    const raw = rawView(reported);
    return {
        ...raw,
        findings: raw.findings.map(finding =>
            finding.kind === 'defect' && !verification.changedPaths.includes(finding.file) ? { ...finding, kind: 'omission' as const } : finding,
        ),
    };
};

const normalized = (path: string): string => path.replace(/^\.\//, '');

/** Whether a finding points at the seeded defect: its lines, or its file for an omission, which cites no line. */
export const findingHitsTruth = (finding: ReviewFinding, truth: Extract<ReviewEvalTruth, { kind: 'defect' }>): boolean => {
    if (normalized(finding.file) !== truth.file) return false;
    if (finding.kind === 'omission') return true;
    const [first, last] = truth.lines;
    return finding.line !== undefined && finding.line >= first && finding.line <= last;
};

export type ReviewCaseScore =
    | {
          kind: 'defect';
          caseId: string;
          class: string;
          rejected: boolean;
          /** Any finding at the defect. */
          caught: boolean;
          /** A blocker at the defect, the only kind that sends the work back. */
          blocked: boolean;
          /** The finding counted, for a person to read. */
          match?: ReviewFinding;
          /** Blockers elsewhere. Not scored wrong: they may be real, and nobody has checked. */
          otherBlockers: number;
          atFindingsCap: boolean;
      }
    | {
          kind: 'control';
          caseId: string;
          rejected: boolean;
          /** Passed with no blocker: the clean diff went through. */
          clean: boolean;
          blockers: number;
          concerns: number;
          atFindingsCap: boolean;
      };

export const scoreCase = (caseId: string, truth: ReviewEvalTruth, view: ReviewView): ReviewCaseScore => {
    const blockers = view.findings.filter(finding => finding.severity === 'blocker');
    const atFindingsCap = view.findings.length >= FINDINGS_CAP;

    if (truth.kind === 'control') {
        return {
            kind: 'control',
            caseId,
            rejected: view.rejected,
            clean: !view.rejected && view.verdict === 'pass' && blockers.length === 0,
            blockers: blockers.length,
            concerns: view.findings.length - blockers.length,
            atFindingsCap,
        };
    }

    const blocking = blockers.find(finding => findingHitsTruth(finding, truth));
    const match = blocking ?? view.findings.find(finding => findingHitsTruth(finding, truth));
    return {
        kind: 'defect',
        caseId,
        class: truth.class,
        rejected: view.rejected,
        caught: match !== undefined,
        blocked: blocking !== undefined,
        ...(match && { match }),
        otherBlockers: blockers.filter(finding => !findingHitsTruth(finding, truth)).length,
        atFindingsCap,
    };
};

export interface RecallCount {
    caught: number;
    blocked: number;
    n: number;
}

export interface ReviewViewSummary {
    recall: RecallCount;
    recallByClass: Record<string, RecallCount>;
    specificity: { clean: number; n: number };
    /** Results that count for nothing, included in both denominators above as misses. */
    rejected: number;
    /** Results at the cap, where a finding past it could not have been reported. */
    atFindingsCap: number;
    /** Blockers on a defect case away from the defect. */
    otherBlockers: number;
}

const addTo = (count: RecallCount, score: { caught: boolean; blocked: boolean }): void => {
    count.n += 1;
    if (score.caught) count.caught += 1;
    if (score.blocked) count.blocked += 1;
};

export const summarizeView = (scores: ReviewCaseScore[]): ReviewViewSummary => {
    const summary: ReviewViewSummary = {
        recall: { caught: 0, blocked: 0, n: 0 },
        recallByClass: {},
        specificity: { clean: 0, n: 0 },
        rejected: 0,
        atFindingsCap: 0,
        otherBlockers: 0,
    };
    for (const score of scores) {
        if (score.rejected) summary.rejected += 1;
        if (score.atFindingsCap) summary.atFindingsCap += 1;
        if (score.kind === 'control') {
            summary.specificity.n += 1;
            if (score.clean) summary.specificity.clean += 1;
            continue;
        }
        summary.otherBlockers += score.otherBlockers;
        addTo(summary.recall, score);
        summary.recallByClass[score.class] ??= { caught: 0, blocked: 0, n: 0 };
        addTo(summary.recallByClass[score.class]!, score);
    }
    return summary;
};

/** What was measured. Scores from different labels are different measurements. */
export interface ReviewEvalLabel {
    model: string;
    engine: string;
    /** The lane prompt's revision, as whoever took the snapshot labelled it. */
    promptRevision: string;
    /** A hash of the prompt actually used, so a mislabelled snapshot can be noticed. */
    promptSha256: string;
    /** The commit of the corpus and runner. */
    corpusCommit: string;
}

export interface ReviewEvalReport {
    label: ReviewEvalLabel;
    startedAt: string;
    runs: ReviewEvalRun[];
    raw: { scores: ReviewCaseScore[]; summary: ReviewViewSummary };
    verified: { scores: ReviewCaseScore[]; summary: ReviewViewSummary };
    unscored: { caseId: string; reason: string }[];
}

export const buildReport = (label: ReviewEvalLabel, startedAt: string, runs: ReviewEvalRun[]): ReviewEvalReport => {
    const scored = runs.filter(run => run.unscored === undefined);
    const raw = scored.map(run => scoreCase(run.caseId, run.truth, rawView(run.reported)));
    const verified = scored.map(run => scoreCase(run.caseId, run.truth, verifiedView(run.reported, run.verification)));
    return {
        label,
        startedAt,
        runs,
        raw: { scores: raw, summary: summarizeView(raw) },
        verified: { scores: verified, summary: summarizeView(verified) },
        unscored: runs.flatMap(run => (run.unscored === undefined ? [] : [{ caseId: run.caseId, reason: run.unscored }])),
    };
};

/** Output tokens across runs, which is what the runner's ceiling counts. */
export const outputTokensSpent = (runs: ReviewEvalRun[]): number => runs.reduce((total, run) => total + (run.usage?.outputTokens ?? 0), 0);

const fraction = (part: number, n: number): string => (n === 0 ? 'no cases' : `${part}/${n} (${Math.round((part / n) * 100)}%)`);

const viewLines = (title: string, summary: ReviewViewSummary): string[] => [
    `## ${title}`,
    '',
    `- Recall, a blocker at the defect: ${fraction(summary.recall.blocked, summary.recall.n)}`,
    `- Recall, any finding at the defect: ${fraction(summary.recall.caught, summary.recall.n)}`,
    `- Specificity, a clean diff passed with no blocker: ${fraction(summary.specificity.clean, summary.specificity.n)}`,
    `- Results that counted for nothing: ${summary.rejected}`,
    `- Results at the ${FINDINGS_CAP} finding cap: ${summary.atFindingsCap}`,
    `- Blockers on defect cases away from the defect, unchecked: ${summary.otherBlockers}`,
    '',
    'Recall by class, blocker then any finding:',
    '',
    ...Object.entries(summary.recallByClass)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => `- ${name}: ${count.blocked}/${count.n}, ${count.caught}/${count.n}`),
    '',
];

/** The report a person reads. The caveats go first because they change what the numbers mean. */
export const formatReport = (report: ReviewEvalReport): string =>
    [
        '# Review measurement',
        '',
        `Model ${report.label.model} on ${report.label.engine}, prompt ${report.label.promptRevision} (sha256 ${report.label.promptSha256.slice(0, 12)}).`,
        `Corpus at ${report.label.corpusCommit.slice(0, 12)}, started ${report.startedAt}.`,
        '',
        '- These scores stop at review. A blocker still has to survive challenge, so they overstate what would reach a kickback.',
        '- A match is by location only. Read the matched findings in the results file before quoting recall.',
        '- Type-check evidence, rule judges and learnings did not run, so a live review had more to go on.',
        '- Reviewers ran their allowed commands on this machine, which can reach its local test database.',
        '- A small n moves a lot on one case. Compare runs by the cases that changed, not by the percentages alone.',
        '',
        ...viewLines('Raw, as the model reported', report.raw.summary),
        ...viewLines('Verified, as the runner would act on it', report.verified.summary),
        ...(report.unscored.length > 0
            ? ['## Not scored', '', 'Left out of every n above:', '', ...report.unscored.map(({ caseId, reason }) => `- ${caseId}: ${reason}`), '']
            : []),
    ].join('\n');
