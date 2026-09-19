import type { ReviewCriterion, ReviewFinding } from '#modules/stages/stage.result.js';

const HEADING = '## Review findings';
const CRITERIA_HEADING = '### Criteria';

/** One bullet per finding: severity, `file:line`, the problem and the suggestion. */
const bullet = (finding: ReviewFinding): string =>
    `- **${finding.severity}** \`${finding.file}:${finding.line}\`: ${finding.problem} — ${finding.suggestion}`;

/** One bullet per criterion: its ID, status and note — `AC2 unmet: <note>`. */
const criterionBullet = (criterion: ReviewCriterion): string => `- ${criterion.id} ${criterion.status}: ${criterion.note}`;

/**
 * Fold review findings, and the criteria statuses that went with them, into a card body under a
 * `## Review findings` section.
 *
 * Not one of the plan-contract headings in `PLAN_SECTIONS` — this is runner-appended commentary,
 * always found and always replaced the same way, so a card kicked back three times carries only the
 * findings from its most recent review rather than accumulating three stale sections. Both lists
 * empty removes the section entirely, which is how a card that finally passes review sheds the
 * complaints from the attempt before it.
 *
 * `criteria` renders as a `### Criteria` sub-block, one bullet per criterion, after the findings
 * bullets — omitted entirely when empty, so a review that reports no criteria (a plan with none, or
 * a result reported before this field existed) renders exactly as it did before this field existed.
 *
 * Everything above and below the section is the original body's lines, untouched: only the section
 * itself — from its heading up to (not including) the next top-level heading, or the end of the body
 * — is replaced.
 */
export const withFindings = (body: string, findings: ReviewFinding[], criteria: ReviewCriterion[] = []): string => {
    const lines = body.split('\n');
    const headingIndex = lines.findIndex(line => line.trim() === HEADING);

    const before = headingIndex === -1 ? lines : lines.slice(0, headingIndex);
    let after: string[] = [];
    if (headingIndex !== -1) {
        const rest = lines.slice(headingIndex + 1);
        const nextHeadingOffset = rest.findIndex(line => /^##\s+/.test(line));
        after = nextHeadingOffset === -1 ? [] : rest.slice(nextHeadingOffset);
    }

    if (findings.length === 0 && criteria.length === 0) {
        return [...before, ...after].join('\n');
    }

    const section = [
        HEADING,
        '',
        ...findings.map(bullet),
        ...(criteria.length > 0 ? [...(findings.length > 0 ? [''] : []), CRITERIA_HEADING, '', ...criteria.map(criterionBullet)] : []),
    ];
    const needsLeadingBlank = before.length > 0 && before[before.length - 1]?.trim() !== '';
    const needsTrailingBlank = after.length > 0;

    return [...before, ...(needsLeadingBlank ? [''] : []), ...section, ...(needsTrailingBlank ? [''] : []), ...after].join('\n');
};
