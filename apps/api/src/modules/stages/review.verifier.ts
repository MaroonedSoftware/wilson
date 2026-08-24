import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from 'injectkit';
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
    constructor(private readonly worktrees: WorktreeManager) {}

    async verify({ worktree, result }: VerificationInput): Promise<VerificationOutcome> {
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

        const { verdict, findings } = parsed.data;
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

        const hasBlocker = findings.some(finding => finding.severity === 'blocker');
        if (verdict === 'revise' && !hasBlocker) {
            failures.push('verdict is "revise" but no finding has severity "blocker"');
        }
        if (verdict === 'pass' && hasBlocker) {
            failures.push('verdict is "pass" but at least one finding has severity "blocker"');
        }

        return { passed: failures.length === 0, failures, changedPaths };
    }

    private async countLines(worktreePath: string, path: string): Promise<number | undefined> {
        const raw = await readFile(join(worktreePath, path), 'utf8').catch(() => undefined);
        if (raw === undefined) return undefined;
        return raw.split('\n').length;
    }
}
