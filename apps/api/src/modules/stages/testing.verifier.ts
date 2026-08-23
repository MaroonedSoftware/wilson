import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { WorktreeManager, type Worktree } from '#modules/worktree/worktree.manager.js';
import { runConfiguredCommand } from './run.command.js';
import type { StageConfig } from './stage.config.js';
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
 * Whether a baseline run proves the copied tests exercise this card's change.
 *
 * A parseable report with zero failures proves nothing: the tests ran against the pre-change tree
 * and passed, which is exactly what this check exists to catch. A new test that fails to even
 * import — because it references code the card hasn't written yet — never produces a parseable
 * report at all; a non-zero exit in that case is itself the proof, and is the common case.
 */
export const baselineProvesChange = (counts: TestCounts | undefined, exitedNonZero: boolean): boolean => (counts ? counts.failed > 0 : exitedNonZero);

/**
 * The testing stage's exit condition: the suite is green, the test count has not dropped, no new
 * tests were skipped, and — the baseline check — at least one new test fails against the pre-change
 * tree.
 *
 * The first three are compared against counts from a second worktree cut from the card worktree's
 * own base, rather than from config, so "pre-change" always means what the card actually branched
 * from. `stage.baselineCheck` is the escape hatch for when a baseline run cannot be completed at
 * all; its absence is recorded (logged, not folded into a pass) rather than silently passing —
 * "no baseline" is not the same claim as "no regressions".
 */
@Injectable()
export class TestingVerifier implements StageVerifier {
    constructor(
        private readonly worktrees: WorktreeManager,
        private readonly logger: Logger,
    ) {}

    async verify({ worktree, stage, cardId }: VerificationInput): Promise<VerificationOutcome> {
        const failures: string[] = [];
        const changedPaths = await this.worktrees.changedPaths(worktree);

        if (stage.testCommand) {
            const run = await runConfiguredCommand(worktree.path, stage.testCommand);
            if (run) failures.push(`the suite is not green: ${run.reason}`);
        }

        const counts = await this.readReport(worktree.path, stage.testReportPath, failures);

        if (!changedPaths.some(path => TEST_FILE_PATTERN.test(path))) {
            failures.push('the diff contains no file matching *.test.ts: the testing stage added no tests');
        }

        if (stage.baselineCheck) {
            failures.push(...(await this.checkBaseline(cardId, worktree, stage, changedPaths, counts)));
        } else {
            this.logger.warn('baselineCheck disabled: the baseline and test-count checks were skipped, not passed');
        }

        return { passed: failures.length === 0, failures, changedPaths };
    }

    private async readReport(worktreePath: string, testReportPath: string | undefined, failures: string[]): Promise<TestCounts | undefined> {
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

    /**
     * The fourth check: cut a worktree from the card worktree's own base, run the suite there for
     * real baseline counts, then copy this card's new test files in and run again. If none of them
     * fail against the pre-change tree, they proved nothing about this card's change.
     *
     * Nothing to check if the diff added no test files — the "added no tests" failure above already
     * covers that case, and there is no baseline worktree worth the cost of creating.
     */
    private async checkBaseline(
        cardId: string,
        worktree: Worktree,
        stage: StageConfig,
        changedPaths: string[],
        counts: TestCounts | undefined,
    ): Promise<string[]> {
        const testPaths = changedPaths.filter(path => TEST_FILE_PATTERN.test(path));
        if (testPaths.length === 0) return [];

        const failures: string[] = [];
        const baselineId = `${cardId}-baseline`;
        const baseline = await this.worktrees.create(baselineId, `card/${cardId}-baseline`, worktree.baseSha);

        try {
            if (stage.setupCommand) {
                const setup = await runConfiguredCommand(baseline.path, stage.setupCommand);
                if (setup) {
                    failures.push(`the baseline worktree could not be set up: ${setup.reason}`);
                    return failures;
                }
            }

            if (!stage.testCommand) {
                failures.push('no testCommand configured: the baseline check could not run');
                return failures;
            }

            // A failing baseline suite is not this check's business — the pre-change tree's own
            // health is unrelated to whether this card's tests exercise its change. parseTestReport
            // does not care whether tests failed, only whether the report is readable, so a failing
            // suite reaches here as ordinary counts rather than a pushed failure.
            await runConfiguredCommand(baseline.path, stage.testCommand);
            const baselineCounts = await this.readReport(baseline.path, stage.testReportPath, failures);
            if (counts && baselineCounts) {
                failures.push(...checkCounts(counts, baselineCounts));
            }

            for (const path of testPaths) {
                const dest = join(baseline.path, path);
                await mkdir(dirname(dest), { recursive: true });
                await copyFile(join(worktree.path, path), dest);
            }

            // Delete the first run's report before the second. Otherwise a run that dies before
            // writing one leaves the full-suite report in place, and the check reads its counts as
            // though they described the copied tests. It would err towards failing rather than
            // passing, but on evidence about a different set of tests entirely.
            if (stage.testReportPath) await rm(join(baseline.path, stage.testReportPath), { force: true });

            const run = await runConfiguredCommand(baseline.path, `${stage.testCommand} ${testPaths.join(' ')}`);
            // Unlike the first run, an unreadable report here is expected in the common case — a new
            // test that cannot even import produces no report at all — so it is not pushed as a
            // failure; the exit status carries the proof instead.
            const newCounts = await this.readReport(baseline.path, stage.testReportPath, []);

            if (!baselineProvesChange(newCounts, !!run)) {
                failures.push(
                    `these new tests pass against the pre-change tree, so they do not prove this card's change is exercised: ${testPaths.join(', ')}`,
                );
            }

            return failures;
        } finally {
            await this.worktrees.reclaim(baselineId);
        }
    }
}
