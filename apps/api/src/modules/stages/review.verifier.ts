import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { acceptanceCriteria } from '#modules/board/card.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { ReviewResultSchema } from './stage.result.js';
import type { StageVerifier, VerificationInput, VerificationOutcome } from './stage.verifier.js';

/**
 * The review stage's exit condition: the runner never judges whether a finding is *correct*, only
 * whether the result parses and every finding points at something real in this card's diff. A
 * reviewer that hallucinates a file, a line beyond the file's end, or a verdict that contradicts its
 * own severities has produced a result the runner can catch without knowing anything about the code
 * under review. Merit is the model's business; provenance is the runner's.
 */
@Injectable()
export class ReviewVerifier implements StageVerifier {
    constructor(
        private readonly worktrees: WorktreeManager,
        private readonly logger: Logger,
    ) {}

    async verify({ worktree, result, card }: VerificationInput): Promise<VerificationOutcome> {
        const failures: string[] = [];
        const changedPaths = await this.worktrees.changedPaths(worktree);

        // A reviewer does not edit. This asks what *this stage* wrote, not what the card changed:
        // the review stage resumes the card's branch, so `changedPaths` measures from the fork point
        // and is never empty — it is the diff under review, and the findings must cite it.
        // Checked before the parse below, so a reviewer that both wrote files and returned garbage
        // gets both failures rather than only the first one found.
        const written = await this.worktrees.uncommittedPaths(worktree);
        if (written.length > 0) {
            failures.push(`the review stage changed files, which a reviewer must not do: ${written.join(', ')}`);
        }

        // Nothing to review is not a clean review. A card merged before its review reaches this
        // stage with an empty diff, every finding would fail provenance for citing a file the diff
        // does not contain, and an empty findings list would sail through as a pass.
        if (changedPaths.length === 0) {
            failures.push('the card has an empty diff: there is nothing to review, so a pass here would mean nothing');
        }

        const parsed = ReviewResultSchema.safeParse(result);
        if (!parsed.success) {
            failures.push(`the reported result does not match the review schema: ${parsed.error.message}`);
            return { passed: false, failures, changedPaths };
        }

        const { verdict, findings, criteria } = parsed.data;
        const lineCounts = new Map<string, number | undefined>();

        for (const finding of findings) {
            if (!lineCounts.has(finding.file)) {
                lineCounts.set(finding.file, await this.countLines(worktree.path, finding.file));
            }
            const lineCount = lineCounts.get(finding.file);

            // An omission is a claim about work the card did not do, so there is no line in the diff
            // to cite — the file names where the missing work belongs. What stays checkable is that
            // the file is real: a reviewer still cannot invent one.
            if (finding.kind === 'omission') {
                if (lineCount === undefined) {
                    failures.push(`finding cites ${finding.file}, which does not exist in the worktree`);
                }
                continue;
            }

            if (!changedPaths.includes(finding.file)) {
                // A `defect` outside the diff is only a hallucination if the file it names doesn't
                // exist either. When the file is real, the reviewer just picked the wrong label for
                // a true finding: this is exactly what an "omission" is, so it is corrected rather
                // than failed. The line number stops meaning anything once the finding is no longer
                // about a diff line — it is left on the finding untouched rather than validated or
                // stripped, since mutating what reaches the card is outside this stage's job
                // (provenance, not presentation) and outside this card's scope.
                if (lineCount !== undefined) {
                    this.logger.warn(
                        `finding cites ${finding.file} as kind "defect", but that file is outside this card's diff; ` +
                            `treating it as kind "omission" instead of failing the stage`,
                    );
                    continue;
                }
                failures.push(
                    `finding cites ${finding.file}, which is not in this card's diff (diff touches: ${changedPaths.join(', ') || 'nothing'}). ` +
                        `If the point is that the card should have changed it and did not, report it as kind "omission".`,
                );
                continue;
            }

            if (lineCount === undefined) {
                failures.push(`finding cites ${finding.file}, which could not be read from the worktree`);
            } else if (finding.line !== undefined && finding.line > lineCount) {
                failures.push(`finding cites ${finding.file}:${finding.line}, but the file has only ${lineCount} lines`);
            }
        }

        // Provenance, not merit: every ID the pinned plan named must be accounted for exactly once,
        // and a "met" citation is checked the same way a defect finding's is, just above. A plan with
        // no acceptance criteria bullets skips this whole block, so a card written before this field
        // existed — and every review of it — verifies exactly as it did before this card.
        const planCriteria = acceptanceCriteria(card);
        if (planCriteria.length > 0) {
            const planIds = new Set(planCriteria.map(c => c.id));
            const seenIds = new Set<string>();

            for (const criterion of criteria) {
                if (!planIds.has(criterion.id)) {
                    failures.push(`criterion "${criterion.id}" is not among the pinned plan's acceptance criteria`);
                    continue;
                }
                if (seenIds.has(criterion.id)) {
                    failures.push(`criterion "${criterion.id}" is reported more than once`);
                    continue;
                }
                seenIds.add(criterion.id);

                if (criterion.status !== 'met') continue;
                const file = criterion.file ?? '';
                if (!lineCounts.has(file)) {
                    lineCounts.set(file, await this.countLines(worktree.path, file));
                }
                const lineCount = lineCounts.get(file);
                if (!changedPaths.includes(file)) {
                    failures.push(
                        `criterion "${criterion.id}" cites ${file}, which is not in this card's diff (diff touches: ${changedPaths.join(', ') || 'nothing'})`,
                    );
                } else if (lineCount === undefined) {
                    failures.push(`criterion "${criterion.id}" cites ${file}, which could not be read from the worktree`);
                } else if (criterion.line !== undefined && criterion.line > lineCount) {
                    failures.push(`criterion "${criterion.id}" cites ${file}:${criterion.line}, but the file has only ${lineCount} lines`);
                }
            }

            for (const id of planIds) {
                if (!seenIds.has(id)) {
                    failures.push(`the pinned plan's criterion "${id}" is missing from the reported criteria`);
                }
            }
        }

        // `unmet` counts like a blocker for this same consistency check, regardless of whether the
        // plan itself has criteria bullets: a "pass" that admits an unmet criterion, or a "revise"
        // backed by neither a blocker nor an unmet criterion, is internally inconsistent on its face.
        const hasBlocker = findings.some(finding => finding.severity === 'blocker');
        const hasUnmet = criteria.some(criterion => criterion.status === 'unmet');
        if (verdict === 'revise' && !hasBlocker && !hasUnmet) {
            failures.push('verdict is "revise" but no finding has severity "blocker" and no criterion is "unmet"');
        }
        if (verdict === 'pass' && hasBlocker) {
            failures.push('verdict is "pass" but at least one finding has severity "blocker"');
        }
        if (verdict === 'pass' && hasUnmet) {
            failures.push('verdict is "pass" but at least one criterion is "unmet"');
        }

        return { passed: failures.length === 0, failures, changedPaths };
    }

    private async countLines(worktreePath: string, path: string): Promise<number | undefined> {
        const raw = await readFile(join(worktreePath, path), 'utf8').catch(() => undefined);
        if (raw === undefined) return undefined;
        return raw.split('\n').length;
    }
}
