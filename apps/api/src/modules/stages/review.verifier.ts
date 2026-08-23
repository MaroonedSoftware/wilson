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

        // A reviewer does not edit. Checked before the parse below, so a reviewer that both wrote
        // files and returned garbage gets both failures rather than only the first one found.
        if (changedPaths.length > 0) {
            failures.push(`the review stage changed files, which a reviewer must not do: ${changedPaths.join(', ')}`);
        }

        const parsed = ReviewResultSchema.safeParse(result);
        if (!parsed.success) {
            failures.push(`the reported result does not match the review schema: ${parsed.error.message}`);
            return { passed: false, failures, changedPaths };
        }

        const { verdict, findings } = parsed.data;
        const lineCounts = new Map<string, number | undefined>();

        for (const finding of findings) {
            if (!changedPaths.includes(finding.file)) {
                failures.push(
                    `finding cites ${finding.file}, which is not in this card's diff (diff touches: ${changedPaths.join(', ') || 'nothing'})`,
                );
                continue;
            }

            if (!lineCounts.has(finding.file)) {
                lineCounts.set(finding.file, await this.countLines(worktree.path, finding.file));
            }
            const lineCount = lineCounts.get(finding.file);

            if (lineCount === undefined) {
                failures.push(`finding cites ${finding.file}, which could not be read from the worktree`);
            } else if (finding.line > lineCount) {
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
