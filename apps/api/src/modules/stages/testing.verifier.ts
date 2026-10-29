import { dirname, join } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { expectedSkippedTests } from '#modules/board/card.js';
import { BoardConfig } from '#modules/board/board.config.js';
import { EventLog } from '#modules/events/event.log.js';
import { WorktreeManager, worktreeHost, type Worktree } from '#modules/worktree/worktree.manager.js';
import { pnpmStoreLock, runConfiguredCommand, type CommandFailure } from './run.command.js';
import type { StageConfig } from './stage.config.js';
import { checkFormat, type StageVerifier, type VerificationInput, type VerificationOutcome } from './stage.verifier.js';
import { parseTestReport, type FailingTest, type TestCounts, type TestReport } from './test.report.js';

const TEST_FILE_PATTERN = /(^|\/)[^/]*\.test\.ts$/;

// A leading underscore, or `tmp`/`scratch`/`temp` as the whole leading word (followed by `_`, `.`
// or `-`), not merely a prefix — "temporary.test.ts" and "scratchpad.test.ts" are real names, not
// scratch ones.
const SCRATCH_NAME_PATTERN = /^_|^(?:tmp|scratch|temp)[_.-]/i;

/**
 * Reject a scratch-named test file: a leading underscore or a tmp/scratch/temp prefix, the shape
 * a throwaway file keeps when a stage starts it to try something and then keeps it because the
 * tests turned out worth keeping, without ever renaming it. Judged on the basename only, and only
 * meant to be called on files this card added — a pre-existing file with this shape is not this
 * check's business, and the caller (`TestingVerifier.newTestPaths`) is what enforces that.
 */
export const scratchTestFileName = (path: string): string | undefined => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!SCRATCH_NAME_PATTERN.test(name)) return undefined;
    return (
        `${path} is not a name this suite will keep: rename it to describe the unit under test ` +
        `(the repo's convention is lowercase, dot- or dash-separated, e.g. "shutdown.faketimer.test.ts"), ` +
        `not a leading underscore or a tmp/scratch/temp prefix`
    );
};

/**
 * Compare this run's counts against the baseline, in the order the plan lists them.
 *
 * A missing baseline is not "no regressions" — it is a check that never ran — so it returns no
 * failures at all rather than either passing or failing the comparison; the verifier records that
 * distinction separately instead of folding it into pass/fail.
 *
 * `allowedSkipRise` is a ceiling, not an exact count, and defaults to 0 — today's rule, unchanged,
 * for every caller that does not pass it. A plan may declare it via `expectedSkippedTests`
 * (card.ts) to let a skip it named on purpose through; a declaration never permits removing
 * tests, so the total-count check above is untouched by it (card 0232).
 */
export const checkCounts = (
    counts: TestCounts,
    baseline: { total: number; skipped: number } | undefined,
    allowedSkipRise = 0,
): string[] => {
    if (!baseline) return [];

    const failures: string[] = [];
    if (counts.total < baseline.total) {
        failures.push(`the test count dropped from ${baseline.total} to ${counts.total}: tests were removed`);
    }
    const skipRise = counts.skipped - baseline.skipped;
    if (skipRise > allowedSkipRise) {
        failures.push(
            allowedSkipRise > 0
                ? `the skipped-test count rose from ${baseline.skipped} to ${counts.skipped}, more than the ${allowedSkipRise} this plan declares`
                : `the skipped-test count rose from ${baseline.skipped} to ${counts.skipped}: tests were skipped rather than fixed`,
        );
    }
    return failures;
};

const MAX_NAMED_FAILURES = 5;

/**
 * Format one failing test — or one file that failed to load — for the red-suite failure's first
 * line.
 */
export const describeFailingTest = (test: FailingTest): string =>
    test.name === undefined ? `${test.file} failed to load: ${test.message ?? 'no message'}` : `${test.file} > ${test.name}`;

/**
 * The red-suite failure: which tests failed, named on the first line, with the command's own exit
 * reason kept beneath it.
 *
 * The first line is deliberately the only thing this changes — it is the only part two readers ever
 * see. The board's event log truncates the rest, and card 0234's `## Previous attempts` record keeps
 * only a failure's first line, so a retried testing stage, and a human reading the card, both learn
 * which test broke only from what lands here.
 *
 * Falls back to today's plain message whenever there is nothing to name: `report` is `undefined`
 * (the report was missing, stale or unusable — already recorded as its own failure by `readReport`),
 * or it parsed cleanly but named no failures even though the command exited non-zero — a suite that
 * failed for a reason the report cannot see.
 */
export const redSuiteFailure = (report: TestReport | undefined, run: CommandFailure): string => {
    const failing = report?.failing ?? [];
    if (failing.length === 0) return `the suite is not green: ${run.reason}`;

    const shown = failing.slice(0, MAX_NAMED_FAILURES).map(describeFailingTest);
    const more = failing.length > MAX_NAMED_FAILURES ? ` and ${failing.length - MAX_NAMED_FAILURES} more` : '';
    return `the suite is not green: ${failing.length} failing: ${shown.join('; ')}${more}\n${run.reason}`;
};

/**
 * Whether a baseline run proves the copied tests exercise this card's change.
 *
 * Either signal suffices, and the exit code is not merely a fallback for a missing report. A new
 * test that cannot import the code it tests — the common case, since the card has not written that
 * code in the pre-change tree — makes vitest exit non-zero while writing a perfectly parseable
 * report saying `numFailedTests: 0`. A collection error is not a failed test. Treating the report as
 * authoritative whenever it parsed is what made the first real run of this check report that the
 * tests passed against the pre-change tree when they had not run there at all.
 *
 * A parseable report with zero failures and a clean exit proves nothing: the tests ran against the
 * pre-change tree and passed, which is exactly what this check exists to catch.
 */
export const baselineProvesChange = (counts: TestCounts | undefined, exitedNonZero: boolean): boolean => (counts?.failed ?? 0) > 0 || exitedNonZero;

/**
 * What the baseline check says when it refuses, and why it says more than "these tests prove
 * nothing".
 *
 * The check stays exactly this strict — copying new tests onto the pre-change tree and requiring
 * them to fail there is what separates a real test from one that passes vacuously, and it earned
 * that on cards 0168 and 0178. What it assumes is that every card changes behaviour.
 *
 * A card whose purpose is a regression guard over behaviour that is *already* correct has nothing
 * to fail against: whatever it guards was fixed by an earlier merged card, so the pre-change tree
 * cut here already contains that fix. No rewrite of such a card can pass, and the runner cannot know
 * which earlier change to undo to find out. Card 0184 was decided on 2026-09-02 by accepting that
 * and naming the manual proof here, rather than leaving it to be rediscovered — card 0180 spent
 * three kickbacks and a human flag learning it.
 */
export const baselineRefusal = (testPaths: string[]): string =>
    `these new tests pass against the pre-change tree, so they do not prove this card's change is exercised: ${testPaths.join(', ')}. ` +
    'If this card adds a regression guard over behaviour an earlier card already fixed, it cannot fail here and no rewrite will change that: ' +
    'prove the guard by removing what it guards, record that the test fails without it, then ack and move the card on (card 0184).';

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
        private readonly events: EventLog,
        private readonly config: BoardConfig,
    ) {}

    async verify({ worktree, stage, cardId, card }: VerificationInput): Promise<VerificationOutcome> {
        const failures: string[] = [];
        const changedPaths = await this.worktrees.changedPaths(worktree);

        const startedAt = Date.now();
        const run = stage.testCommand
            ? await runConfiguredCommand(worktree.path, stage.testCommand, undefined, undefined, worktreeHost(worktree))
            : undefined;

        // Read before pushing the red-suite failure below — that failure's first line is built from
        // this report's named failures, so the message needs the report before it can be assembled.
        const counts = await this.readReport(worktree, stage.testReportPath, failures, startedAt);

        if (run) {
            const redFailure = await this.judgeRedRun(cardId, worktree, stage, counts, run);
            if (redFailure) failures.push(redFailure);
        }

        // Formatting is an exit condition, not a habit an agent is asked to remember — this is
        // exactly how card 0032's unformatted test file reached main uncaught: nothing but a
        // by-hand repo-wide check ever ran prettier against a testing-stage diff.
        failures.push(...(await checkFormat(worktree, stage)));

        if (!changedPaths.some(path => TEST_FILE_PATTERN.test(path))) {
            failures.push('the diff contains no file matching *.test.ts: the testing stage added no tests');
        }

        for (const path of await this.newTestPaths(worktree)) {
            const reason = scratchTestFileName(path);
            if (reason) failures.push(reason);
        }

        if (stage.baselineCheck) {
            failures.push(...(await this.checkBaseline(cardId, worktree, stage, changedPaths, counts, expectedSkippedTests(card) ?? 0)));
        } else {
            this.logger.warn('baselineCheck disabled: the baseline and test-count checks were skipped, not passed');
        }

        return { passed: failures.length === 0, failures, changedPaths };
    }

    /**
     * Read a report, refusing one that predates the run that was supposed to write it.
     *
     * `pnpm --filter` exits 0 when its filter matches no project, so a stale package name in stage
     * config turns the test command into a silent no-op. The first time the testing stage ran for
     * real, that is exactly what happened, and a missing report was the only symptom. A report left
     * over from an earlier run would have been worse — it would have been believed.
     *
     * Returns a `TestReport`, not just `TestCounts`, so the red-suite failure above can name which
     * tests failed — the only reason `verify` now reads the report before pushing that failure
     * instead of after.
     */
    private async readReport(
        tree: Worktree,
        testReportPath: string | undefined,
        failures: string[],
        notBefore?: number,
    ): Promise<TestReport | undefined> {
        if (!testReportPath) {
            failures.push('no testReportPath configured: the test report was never checked');
            return undefined;
        }

        const host = worktreeHost(tree);
        const path = join(tree.path, testReportPath);

        if (notBefore !== undefined) {
            const stats = await host.stat(path).catch(() => undefined);
            if (stats && stats.mtimeMs < notBefore) {
                failures.push(`the test report at ${testReportPath} predates this run: the test command wrote nothing`);
                return undefined;
            }
        }

        const raw = await host.readFile(path).catch((err: Error) => err);
        if (raw instanceof Error) {
            failures.push(`could not read test report at ${testReportPath}: ${raw.message}`);
            return undefined;
        }

        try {
            return parseTestReport(raw, tree.path);
        } catch (err) {
            failures.push(`test report at ${testReportPath} is unusable: ${(err as Error).message}`);
            return undefined;
        }
    }

    /**
     * Card 0261. A red run is not necessarily a regression — see the Goal this card records: three
     * cards on 2026-09-19 each cost a stage run or a human to a test that failed once and passed on
     * a bare rerun. Before a red run is judged, the files the report names as failing get one rerun,
     * and only that: `stage.testCommand` with those files' paths appended, the same narrowing the
     * baseline check already does (`checkBaseline` below), never a broader command.
     *
     * No named failures at all — a crash, an unusable report — means there is nothing to rerun, and
     * the run is judged red exactly as it always has been (`redSuiteFailure`, unchanged). A rerun
     * that comes back red too is judged red with today's message, built from the *first* run's
     * report and reason, not the rerun's — this was not a flake, so nothing about it needs to be
     * re-described. A rerun that comes back green appends a `test.flaky` event naming the tests and
     * returns `undefined`, so `verify`'s other checks decide the outcome as though the suite were
     * green — unless the card already carries a `test.flaky` event naming one of the same tests, in
     * which case recurrence itself fails the run with `flaky: <names>` rather than passing again.
     * That is deliberately not a direct flag: a verifier cannot set `needsHuman` itself, so a
     * recurring flake only reaches a human the ordinary way, through `testing.onFail: testing` and
     * then `maxKickbacks`.
     */
    private async judgeRedRun(
        cardId: string,
        worktree: Worktree,
        stage: StageConfig,
        report: TestReport | undefined,
        run: CommandFailure,
    ): Promise<string | undefined> {
        const failing = report?.failing ?? [];
        if (failing.length === 0 || !stage.testCommand) return redSuiteFailure(report, run);

        const files = [...new Set(failing.map(test => test.file))];
        const rerun = await runConfiguredCommand(
            worktree.path,
            `${stage.testCommand} ${files.join(' ')}`,
            undefined,
            undefined,
            worktreeHost(worktree),
        );
        if (rerun) return redSuiteFailure(report, run);

        const names = failing.map(describeFailingTest);
        const recurring = await this.recurringFlake(cardId, names);
        if (recurring.length > 0) return `flaky: ${recurring.join(', ')}`;

        await this.events.append({
            project: this.config.project,
            cardId,
            stage: stage.name,
            type: 'test.flaky',
            payload: { tests: names, run: 'testing' },
        });
        return undefined;
    }

    /**
     * Which of `names` already appears in a `test.flaky` event this card carries — the recurrence
     * that turns "flaky, ignore it" into "flags a human" (this card's Constraints). Reads the tail
     * the same way `ChallengeVerifier.incomingReview` and `BoardWriteService.division` already read
     * a card's own history, rather than tracking a separate counter.
     */
    private async recurringFlake(cardId: string, names: string[]): Promise<string[]> {
        const rows = await this.events.tail(this.config.project, cardId);
        const seen = new Set<string>();
        for (const row of rows) {
            if (row.type !== 'test.flaky') continue;
            const priorTests = row.payload?.tests;
            if (!Array.isArray(priorTests)) continue;
            for (const name of priorTests) {
                if (typeof name === 'string' && names.includes(name)) seen.add(name);
            }
        }
        return [...seen];
    }

    /**
     * Test files this card *added*, as distinct from `changedPaths`' broader "touched since base" —
     * a pre-existing test file this card only modified is not the naming check's business, so an
     * `M` in `git diff --name-status` is excluded here even though `changedPaths` would include it.
     * A file git has never seen (untracked) is added by definition. `WorktreeManager.addedPaths`
     * does the actual git call, so `worktree.baseSha` is dereferenced there and not here too.
     */
    private async newTestPaths(worktree: Worktree): Promise<string[]> {
        return (await this.worktrees.addedPaths(worktree)).filter(path => TEST_FILE_PATTERN.test(path));
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
        allowedSkipRise: number,
    ): Promise<string[]> {
        // `changedPaths` is every path the diff touches, deletions included — and a card that
        // deletes a test file has a path here that no longer exists in the worktree. Copying it into
        // the baseline tree fails with ENOENT and takes the whole stage down with it, which is what
        // happened to card 0078 once its `wilson card run` test file was removed. Deleted tests are
        // not this check's business anyway: it exists to prove the card's *new* tests fail against
        // the pre-change tree, and a test that no longer exists cannot be run in either tree.
        const candidatePaths = changedPaths.filter(path => TEST_FILE_PATTERN.test(path));
        const testPaths = (
            await Promise.all(
                candidatePaths.map(async path =>
                    (await worktreeHost(worktree)
                        .stat(join(worktree.path, path))
                        .catch(() => undefined))
                        ? path
                        : undefined,
                ),
            )
        ).filter((path): path is string => path !== undefined);
        if (testPaths.length === 0) return [];

        const failures: string[] = [];
        const baselineId = `${cardId}-baseline`;
        // On the card's own host when it has one: the test files are copied across from the card's
        // worktree, and both trees have to be on the same disk for that.
        const baseline = await this.worktrees.create(baselineId, `card/${cardId}-baseline`, worktree.baseSha, worktree.placement);

        try {
            if (stage.setupCommand) {
                // The third install path, and the one card 0081 missed while fixing itself: this is
                // a second `pnpm install`, into the same shared store, running while another card's
                // setup may be installing too. 0081 wrapped the dispatcher's setup and the agent's
                // bash `pnpm install` but not this, and was then poisoned when a redelivered attempt's
                // setup raced the baseline install of the attempt still running. Same lock, so all
                // three paths serialize against each other rather than two of three.
                const setupCommand = stage.setupCommand;
                const setup = await pnpmStoreLock.run(
                    `${cardId} testing baseline setup`,
                    message => this.logger.info(message),
                    () => runConfiguredCommand(baseline.path, setupCommand, undefined, undefined, worktreeHost(baseline)),
                );
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
            const baselineStartedAt = Date.now();
            await runConfiguredCommand(baseline.path, stage.testCommand, undefined, undefined, worktreeHost(baseline));
            const baselineCounts = await this.readReport(baseline, stage.testReportPath, failures, baselineStartedAt);
            if (counts && baselineCounts) {
                failures.push(...checkCounts(counts, baselineCounts, allowedSkipRise));
            }

            for (const path of testPaths) {
                const dest = join(baseline.path, path);
                await worktreeHost(baseline).mkdir(dirname(dest));
                await worktreeHost(baseline).copyFile(join(worktree.path, path), dest);
            }

            // Delete the first run's report before the second. Otherwise a run that dies before
            // writing one leaves the full-suite report in place, and the check reads its counts as
            // though they described the copied tests. It would err towards failing rather than
            // passing, but on evidence about a different set of tests entirely.
            if (stage.testReportPath) await worktreeHost(baseline).removeTree(join(baseline.path, stage.testReportPath));

            const run = await runConfiguredCommand(
                baseline.path,
                `${stage.testCommand} ${testPaths.join(' ')}`,
                undefined,
                undefined,
                worktreeHost(baseline),
            );
            // Unlike the first run, an unreadable report here is expected in the common case — a new
            // test that cannot even import produces no report at all — so it is not pushed as a
            // failure; the exit status carries the proof instead.
            const newCounts = await this.readReport(baseline, stage.testReportPath, []);

            if (!baselineProvesChange(newCounts, !!run)) {
                failures.push(baselineRefusal(testPaths));
            }

            return failures;
        } finally {
            await this.worktrees.reclaim(baselineId, worktree.placement);
        }
    }
}
