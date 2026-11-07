import { earlierFindings } from '#modules/board/append.findings.js';
import type { Card } from '#modules/board/card.js';
import { isRuleFinding } from '#modules/rules/rule.findings.js';
import { ReviewResultSchema, type ReviewFinding, type ReviewResult } from './stage.result.js';

/** What a demoted blocker's problem starts with, so the plan and the event say why it no longer blocks. */
export const DEMOTED_PREFIX = '[not blocking after the first review] ';

/**
 * Whether this review is a later round: an earlier review of the same card left a blocker on its plan.
 * A card whose earlier review raised only concerns, or none, is still on its first round of blockers.
 */
export const isLaterReview = (card: Card): boolean => earlierFindings(card.body).some(finding => finding.severity === 'blocker');

/**
 * Whether a later review's blocker may still block, by the reason it gives. Only four reasons do:
 * an earlier blocker still unfixed (and then it must name a file an earlier blocker named), something
 * the repair broke, an acceptance criterion still unmet, or safety. A rule's own failure always may,
 * since a person stated the rule.
 */
const mayStillBlock = (finding: ReviewFinding, earlierFiles: ReadonlySet<string>): boolean => {
    if (isRuleFinding(finding)) return true;
    switch (finding.basis) {
        case 'regression':
        case 'criterion':
        case 'safety':
            return true;
        case 'unfixed':
            return earlierFiles.has(finding.file);
        default:
            return false;
    }
};

/** A later review's report with its scope held, and the problems of the blockers it turned into concerns. */
export interface FrozenScope {
    result: unknown;
    demoted: string[];
}

/**
 * Hold a later review to the scope its first round set, so a card is not sent back again and again
 * for things nobody raised when it was first reviewed. From the second review of a card on, a blocker
 * that gives none of the reasons {@link mayStillBlock} accepts becomes a concern: it stays on the
 * report and reaches the plan, prefixed with {@link DEMOTED_PREFIX}, and stops nothing. A `revise` left
 * with no blocker and no unmet criterion becomes a `pass`.
 *
 * A first review is left exactly as it is, and so is a report that does not parse, which is sent
 * again for that anyway.
 */
export const withFrozenScope = (result: unknown, card: Card): FrozenScope => {
    const earlier = earlierFindings(card.body);
    if (!earlier.some(finding => finding.severity === 'blocker')) return { result, demoted: [] };
    const parsed = ReviewResultSchema.safeParse(result);
    if (!parsed.success) return { result, demoted: [] };

    const earlierFiles = new Set(earlier.filter(finding => finding.severity === 'blocker').map(finding => finding.file));
    const demoted: string[] = [];
    const findings = parsed.data.findings.map(finding => {
        if (finding.severity !== 'blocker' || mayStillBlock(finding, earlierFiles)) return finding;
        demoted.push(finding.problem);
        return { ...finding, severity: 'concern' as const, problem: `${DEMOTED_PREFIX}${finding.problem}` };
    });
    if (demoted.length === 0) return { result, demoted };

    const blocks = findings.some(finding => finding.severity === 'blocker') || parsed.data.criteria.some(criterion => criterion.status === 'unmet');
    const held: ReviewResult = { ...parsed.data, findings, verdict: blocks ? parsed.data.verdict : 'pass' };
    return { result: held, demoted };
};
