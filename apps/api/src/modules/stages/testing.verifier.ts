import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { runConfiguredCommand } from './run.command.js';
import type { StageVerifier, VerificationInput, VerificationOutcome } from './stage.verifier.js';
import { parseTestReport, type TestCounts } from './test.report.js';

const TEST_FILE_PATTERN = /(^|\/)[^/]*\.test\.ts$/;

/**
 * Compare this run's counts against the baseline, in the order the plan lists them.
 *
 * A missing baseline is not "no regressions" — it is a check that never ran — so it returns no
 * failures at all rather than either passing or failing the comparison; the verifier records that
 * distinction separately instead of folding it into pass/fail.
 */
export const checkCounts = (counts: TestCounts, baseline: { total: number; skipped: number } | undefined): string[] => {
    if (!baseline) return [];

    const failures: string[] = [];
    if (counts.total < baseline.total) {
        failures.push(`the test count dropped from ${baseline.total} to ${counts.total}: tests were removed`);
    }
    if (counts.skipped > baseline.skipped) {
        failures.push(`the skipped-test count rose from ${baseline.skipped} to ${counts.skipped}: tests were skipped rather than fixed`);
    }
    return failures;
};

/**
 * The testing stage's exit condition, covering three of its four checks: the suite is green, the
 * test count has not dropped, and no new tests were skipped.
 *
 * The fourth check — new tests must fail against the pre-change tree — needs a second worktree and
 * is card 0004. `baselineCounts` is the seam it will fill in: today it comes from config, and when
 * absent the two count checks are skipped with a recorded note (logged, not folded into a pass)
 * rather than silently passing — "no baseline" is not the same claim as "no regressions".
 */
@Injectable()
export class TestingVerifier implements StageVerifier {
    constructor(
        private readonly worktrees: WorktreeManager,
        private readonly logger: Logger,
    ) {}

    async verify({ worktree, stage }: VerificationInput): Promise<VerificationOutcome> {
        const failures: string[] = [];
        const changedPaths = await this.worktrees.changedPaths(worktree);

        if (stage.testCommand) {
            const run = await runConfiguredCommand(worktree.path, stage.testCommand);
            if (run) failures.push(`the suite is not green: ${run.reason}`);
        }

        const counts = await this.readReport(worktree.path, stage.testReportPath, failures);

        if (counts) {
            if (stage.baselineCounts) {
                failures.push(...checkCounts(counts, stage.baselineCounts));
            } else {
                this.logger.warn('no baselineCounts configured: the test-count checks were skipped, not passed');
            }
        }

        if (!changedPaths.some(path => TEST_FILE_PATTERN.test(path))) {
            failures.push('the diff contains no file matching *.test.ts: the testing stage added no tests');
        }

        return { passed: failures.length === 0, failures, changedPaths };
    }

    private async readReport(
        worktreePath: string,
        testReportPath: string | undefined,
        failures: string[],
    ): Promise<TestCounts | undefined> {
        if (!testReportPath) {
            failures.push('no testReportPath configured: the test report was never checked');
            return undefined;
        }

        const path = join(worktreePath, testReportPath);
        const raw = await readFile(path, 'utf8').catch((err: Error) => err);
        if (raw instanceof Error) {
            failures.push(`could not read test report at ${testReportPath}: ${raw.message}`);
            return undefined;
        }

        try {
            return parseTestReport(raw);
        } catch (err) {
            failures.push(`test report at ${testReportPath} is unusable: ${(err as Error).message}`);
            return undefined;
        }
    }
}
