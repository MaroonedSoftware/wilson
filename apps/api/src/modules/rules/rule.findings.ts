import type { ReviewFinding, ReviewResult } from '#modules/stages/stage.result.js';
import type { RuleVerdict } from './rule.judge.js';

/** `ReviewResultSchema`'s cap on findings. A report over it would be rejected as the reviewer's fault. */
export const MAX_REVIEW_FINDINGS = 20;

/**
 * What a rule's finding says. Starts with the rule's id, which is unique, so two rules can never share
 * the text `ChallengeVerifier` accounts for a blocker by.
 */
const problemOf = (verdict: RuleVerdict): string => `Rule ${verdict.rule} failed: ${oneLine(verdict.evidence)}`;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Whether a finding came from a rule rather than from the reviewer. */
export const isRuleFinding = (finding: Pick<ReviewFinding, 'problem'>): boolean => /^Rule [a-z0-9-]+ failed: /.test(finding.problem);

/** How long each file a citation could name is, in lines, as `ReviewVerifier` counts them. Absent for one that is not there. */
export type LineCounts = ReadonlyMap<string, number>;

/**
 * A failed rule as a finding `ReviewVerifier` will accept.
 *
 * Only a citation that holds up can stop a card: the file has to be there and the line has to be in it,
 * and a blocker rule's failure with one forces `revise`. Anything less is a concern. It stays in the
 * report, as an omission naming a file the rule was about, since a finding has to name one that exists.
 * A rule whose files are all gone has none to name, so it gets no finding and the plan alone reports it.
 */
export const ruleFinding = (verdict: RuleVerdict, lines: LineCounts): ReviewFinding | undefined => {
    const lineCount = verdict.file === undefined ? undefined : lines.get(verdict.file);
    const cited = verdict.file !== undefined && verdict.line !== undefined && lineCount !== undefined && verdict.line <= lineCount;
    const suggestion = `Change the code so that this holds: ${oneLine(verdict.statement)}`;
    if (cited) {
        return {
            severity: verdict.severity,
            kind: 'defect',
            file: verdict.file!,
            line: verdict.line,
            problem: problemOf(verdict),
            suggestion,
        };
    }
    const file = verdict.file !== undefined && lineCount !== undefined ? verdict.file : verdict.paths.find(path => lines.has(path));
    if (file === undefined) return undefined;
    return { severity: 'concern', kind: 'omission', file, problem: problemOf(verdict), suggestion };
};

/**
 * Fold rule findings into a review's report, before `ReviewVerifier` reads it. From here a rule's
 * blocker is an ordinary blocker: a `revise` that goes through the challenge step and kickback as any
 * other does, and the routing in `writeTransition` needs to know nothing about rules.
 *
 * The rules' blockers come first and the review's concerns are the first to go when the cap is reached,
 * then the rules' concerns. Only more than twenty blockers can cost one, and the verdict is `revise`
 * then whichever ones remain.
 */
export const withRuleFindings = (result: ReviewResult, ruleFindings: readonly ReviewFinding[]): ReviewResult => {
    if (ruleFindings.length === 0) return result;
    const blockers = (findings: readonly ReviewFinding[]) => findings.filter(finding => finding.severity === 'blocker');
    const concerns = (findings: readonly ReviewFinding[]) => findings.filter(finding => finding.severity !== 'blocker');
    const failed = blockers(ruleFindings).length;
    return {
        ...result,
        verdict: failed > 0 ? 'revise' : result.verdict,
        summary: failed > 0 ? `${result.summary} ${failed === 1 ? 'A checked rule' : `${failed} checked rules`} also failed.` : result.summary,
        findings: [...blockers(ruleFindings), ...blockers(result.findings), ...concerns(ruleFindings), ...concerns(result.findings)].slice(
            0,
            MAX_REVIEW_FINDINGS,
        ),
    };
};

const verdictLine = (verdict: RuleVerdict): string => {
    const name = `**${verdict.rule}**`;
    if (verdict.verdict === 'pass') return `- ${name}: passed.`;
    if (verdict.verdict === 'unavailable') return `- ${name}: no verdict, so it stops nothing (${oneLine(verdict.evidence)}).`;
    const at = verdict.file ? ` at ${verdict.file}${verdict.line ? `:${verdict.line}` : ''}` : '';
    return `- ${name}: failed${at}. ${oneLine(verdict.evidence)}`;
};

/** The verdicts as a section of the reviewer's plan, so it does not spend its own time on the same questions. */
export const ruleVerdictsMarkdown = (verdicts: readonly RuleVerdict[]): string =>
    verdicts.length === 0
        ? ''
        : [
              '## Rule verdicts',
              '',
              "Independent judges checked this card's diff against the project's rules. The runner adds their failures to your report, so do not judge these rules again or report them yourself. Spend your review on everything else.",
              '',
              ...verdicts.map(verdictLine),
          ].join('\n');

/**
 * What the challenge step has to account for, in the words its report has to use. A review's result is
 * in the event log and not in the card, which is only written once the step has spoken, so this is how
 * the step gets it. `problem` is what `ChallengeVerifier` matches on.
 */
export const incomingBlockersMarkdown = (blockers: readonly Pick<ReviewFinding, 'problem' | 'file' | 'line'>[]): string =>
    blockers.length === 0
        ? ''
        : [
              '## Blockers to challenge',
              '',
              'The review raised these. Uphold each one in `findings` or refute it in `refuted`, with its `problem` text exactly as written here.',
              '',
              ...blockers.map(blocker => `- ${blocker.file}${blocker.line ? `:${blocker.line}` : ''}: ${blocker.problem}`),
          ].join('\n');
