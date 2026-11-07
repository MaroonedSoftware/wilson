import { dirname, join } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { expectedAssertionDrop, expectedSkippedTests } from '#modules/board/card.js';
import { BoardConfig } from '#modules/board/board.config.js';
import { EventLog } from '#modules/events/event.log.js';
import { WorktreeManager, worktreeHost, type Worktree } from '#modules/worktree/worktree.manager.js';
import { assertionDelta, isAssertionTestFile, type AssertionDelta, type LocatedAssertion } from './assertion.delta.js';
import { withBaselineWorktree } from './baseline.worktree.js';
import { runConfiguredCommand, type CommandFailure } from './run.command.js';
import type { StageConfig } from './stage.config.js';
import { checkFormat, checkSecrets, type StageVerifier, type VerificationInput, type VerificationOutcome } from './stage.verifier.js';
import { archiveTestReport } from './test.report.archive.js';
import { parseTestReport, type FailingTest, type TestCounts, type TestReport } from './test.report.js';

/**
 * A vitest test file. Its four uses below split in two (card 0037):
 *
 * - the no-tests check and the scratch-name check (`newTestPaths`) only ask whether a path *is* a
 *   test, and could take a Kotlin file as well;
 * - the baseline run and its candidate paths (`checkBaseline`) hand the paths to `stage.testCommand`
 *   and read the vitest report it writes, so they must never see a Kotlin file. Neither must the
 *   red-run rerun or the test-count comparison, which read that same report.
 *
 * So this stays `*.test.ts`, and an Android-only diff takes its own path (`isAndroidOnlyDiff`,
 * `KOTLIN_TEST_FILE_PATTERN`) rather than this pattern growing a `.kt` branch.
 */
const TEST_FILE_PATTERN = /(^|\/)[^/]*\.test\.ts$/;

/** Code that belongs to the Android app: the app itself and the Kotlin SDK it builds against. */
const ANDROID_PATH_PATTERN = /^(?:apps\/android|packages\/sdk-kotlin)\//;

/**
 * Paths an Android-only card may also carry without stopping being one: Markdown (a changeset, a
 * README, PROJECT.md) and the runner's own `.wilson-*` bookkeeping. Neither can hold TypeScript.
 */
const NON_CODE_PATH_PATTERN = /\.md$|(^|\/)\.wilson-[^/]*$/;

/** A Kotlin unit test of the Android app: `apps/android/<module>/src/test/**\/<Name>Test.kt`. */
export const KOTLIN_TEST_FILE_PATTERN = /^apps\/android\/(?:[^/]+\/)*src\/test\/(?:[^/]+\/)*[^/]+Test\.kt$/;

/**
 * How the testing stage runs the Android app's unit tests, from the worktree root. Fixed here and
 * never taken from the agent or a plan: `./gradlew :app:testDebugUnitTest`, spelled for a cwd at the
 * repo root (`-p` points gradle at the Android project). A stage that may run it itself lists this
 * exact string in its `allowedCommands`, and `CommandAllowlist` accepts a gradle entry only verbatim.
 */
export const KOTLIN_TEST_COMMAND = 'apps/android/gradlew -p apps/android :app:testDebugUnitTest';

/**
 * Whether this diff changes only the Android app (card 0037): at least one path under `apps/android`
 * or `packages/sdk-kotlin`, and every other path Markdown or runner bookkeeping. Anything else — a
 * `.ts` file above all — makes it an ordinary diff, which still needs a `*.test.ts`. A mixed diff is
 * deliberately not Android-only: adding a Kotlin test must never excuse untested TypeScript.
 */
export const isAndroidOnlyDiff = (changedPaths: readonly string[]): boolean =>
    changedPaths.some(path => ANDROID_PATH_PATTERN.test(path)) &&
    changedPaths.every(path => ANDROID_PATH_PATTERN.test(path) || NON_CODE_PATH_PATTERN.test(path));

/**
 * The checks an Android-only diff does not run, because each reads the vitest report that only
 * `stage.testCommand` writes. Logged as skipped, never folded into a pass.
 */
export const ANDROID_SKIPPED_CHECKS = [
    'the vitest run and its report',
    'the test-count and skipped-count comparison against the baseline',
    'the failing-file rerun for flakes',
    'the pre-existing-failure exemption',
    'the scratch-name check on *.test.ts files',
] as const;

/** The no-tests failure for an Android-only diff. */
export const NO_KOTLIN_TEST_FAILURE =
    'the diff changes only Android code and contains no file matching apps/android/**/src/test/**/*Test.kt: the testing stage added no tests';

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
export const checkCounts = (counts: TestCounts, baseline: { total: number; skipped: number } | undefined, allowedSkipRise = 0): string[] => {
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

/** An assertion can be a whole object literal, and the attempt record keeps 200 characters of a line. */
const MAX_ASSERTION_CHARS = 80;

const describeAssertion = ({ text }: LocatedAssertion): string =>
    text.length > MAX_ASSERTION_CHARS ? `${text.slice(0, MAX_ASSERTION_CHARS)}…` : text;

/**
 * Judge what a card did to its assertions: a net drop, or a new tautology. `allowedDrop` is a plan's
 * declared ceiling (`expectedAssertionDrop`), and both spend it, since a tautology is an assertion
 * that stopped asserting. So one assertion replaced by `expect(true).toBe(true)` uses one.
 *
 * Each failure opens with the file and the assertion. A retried stage keeps only the first line of a
 * failure, cut at 200 characters (`append.attempts.ts`), so that is all it learns from this. How to
 * declare a drop is left to the second line, because it is for whoever reads the board: the fix a
 * retry should reach for is restoring the assertion.
 */
export const checkAssertionDelta = (delta: AssertionDelta, allowedDrop = 0): string[] => {
    const drop = Math.max(0, delta.baseCount - delta.currentCount);
    if (drop + delta.newTautologies.length <= allowedDrop) return [];

    const overDeclared = allowedDrop > 0 ? `, more than the ${allowedDrop} this plan declares` : '';
    const declare = "A plan Constraint `Expected assertion drop: N (reason)` allows a deliberate change; a stage's caveats do not.";
    const failures: string[] = [];

    const lost = delta.lost[0];
    if (drop > 0 && lost) {
        failures.push(
            `${lost.path}:${lost.line} lost ${describeAssertion(lost)}: assertions fell from ${delta.baseCount} to ${delta.currentCount} across this card${overDeclared}\n${declare}`,
        );
    }

    const [tautology, ...others] = delta.newTautologies;
    if (tautology) {
        const more = others.length > 0 ? ` and ${others.length} more` : '';
        failures.push(
            `${tautology.path}:${tautology.line} adds ${describeAssertion(tautology)}, which cannot fail${more}${overDeclared}\n${declare}`,
        );
    }
    return failures;
};

const MAX_NAMED_FAILURES = 5;

/** A failure message's first line can be a whole serialized value; the name matters more. */
const MAX_FAILURE_MESSAGE_CHARS = 200;

/**
 * Format one failing test — or one file that failed to load — for the red-suite failure's first
 * line.
 */
export const describeFailingTest = (test: FailingTest): string =>
    test.name === undefined ? `${test.file} failed to load: ${test.message ?? 'no message'}` : `${test.file} > ${test.name}`;

/**
 * `describeFailingTest` with why the test failed, for a person to read. Kept apart from it because
 * that string is also a test's identity: `recurringFlake` compares it across runs, and a message that
 * changes between runs would stop a recurring flake from being recognised.
 */
export const describeFailure = (test: FailingTest): string => {
    if (test.name === undefined || test.message === undefined) return describeFailingTest(test);
    const message = test.message.length > MAX_FAILURE_MESSAGE_CHARS ? `${test.message.slice(0, MAX_FAILURE_MESSAGE_CHARS)}…` : test.message;
    return `${describeFailingTest(test)}: ${message}`;
};

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
export const redSuiteFailure = (report: TestReport | undefined, run: CommandFailure, archivedReport?: string): string =>
    `the suite is not green: ${redRunDetail(report, run, archivedReport)}`;

/**
 * What a red run has to say for itself, without saying which check it failed: the failing tests
 * when the report names any, then the command's own reason. Shared with the merge check
 * (`BoardWriteService.judgeFailedMergeSuite`), which frames it as a merge that fails the suite, so
 * the two cannot drift back apart: the merge check used to keep only `run.reason`, whose last 4000
 * characters can be nothing but warnings, and card 0007's refused merge named no test at all.
 */
export const redRunDetail = (report: TestReport | undefined, run: CommandFailure, archivedReport?: string): string => {
    const failing = report?.failing ?? [];
    const lines = archivedReport === undefined ? [run.reason] : [`full report: ${archivedReport}`, run.reason];
    if (failing.length === 0) return lines.join('\n');

    const shown = failing.slice(0, MAX_NAMED_FAILURES).map(describeFailure);
    const more = failing.length > MAX_NAMED_FAILURES ? ` and ${failing.length - MAX_NAMED_FAILURES} more` : '';
    return [`${failing.length} failing: ${shown.join('; ')}${more}`, ...lines].join('\n');
};

/**
 * A failing test's identity across two trees: its file and name, never its message. A file that
 * failed to load has no name, and its message can carry the worktree's own absolute path, so two
 * trees that fail the same way would never match on `describeFailingTest`.
 */
export const failingTestKey = (test: FailingTest): string =>
    test.name === undefined ? `${test.file} failed to load` : `${test.file} > ${test.name}`;

/**
 * Split a red run's failures into those `known` already fails (the baseline tree's report, or a
 * `test.preexisting` event's keys) and those this card introduced. A failure that is red on the
 * tree the card branched from is not the card's fault: on Tower between 2026-10-31 and 2026-11-06,
 * about seven testing and merge failures were tests red for every card (an unreachable test
 * database, a test reading a path relative to cwd, a test failing on `main`).
 */
export const partitionPreExisting = (
    failing: readonly FailingTest[],
    known: ReadonlySet<string>,
): { preExisting: FailingTest[]; introduced: FailingTest[] } => {
    const preExisting: FailingTest[] = [];
    const introduced: FailingTest[] = [];
    for (const test of failing) (known.has(failingTestKey(test)) ? preExisting : introduced).push(test);
    return { preExisting, introduced };
};

/** The keys of every test a baseline report names as failing. */
export const failingKeys = (report: TestReport | undefined): Set<string> => new Set((report?.failing ?? []).map(failingTestKey));

/**
 * A red run that the rerun did not clear. `failing` is set only when the report named failures,
 * which is what a baseline can exempt; a crash or an unusable report has nothing to compare.
 */
interface RedRun {
    report: TestReport | undefined;
    run: CommandFailure;
    archived: string | undefined;
    failing?: FailingTest[];
}

/** What the baseline check found, and the baseline suite's own report for the red-run judgement. */
interface BaselineCheck {
    failures: string[];
    report?: TestReport;
}

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
 * tests were skipped, existing tests were not weakened, and — the baseline check — at least one new
 * test fails against the pre-change tree.
 *
 * The first three are compared against counts from a second worktree cut from the card worktree's
 * own base, rather than from config, so "pre-change" always means what the card actually branched
 * from. `stage.baselineCheck` is the escape hatch for when a baseline run cannot be completed at
 * all; its absence is recorded (logged, not folded into a pass) rather than silently passing —
 * "no baseline" is not the same claim as "no regressions".
 *
 * "Green" excuses what the card did not cause: a test that fails once and passes on a rerun
 * (`judgeRedRun`), and a test that fails on that same baseline tree too (`judgePreExisting`).
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
        // First, so that it is the failure an operator reads: it is the one no retry can settle.
        const secrets = await checkSecrets(this.worktrees, worktree, card);
        const failures: string[] = [...secrets.failures];
        const changedPaths = await this.worktrees.changedPaths(worktree);

        if (isAndroidOnlyDiff(changedPaths)) {
            failures.push(...(await this.verifyAndroid(cardId, worktree, stage, card, changedPaths)));
            return {
                passed: failures.length === 0,
                failures,
                changedPaths,
                ...(secrets.needsHumanReason ? { needsHumanReason: secrets.needsHumanReason } : {}),
            };
        }

        const startedAt = Date.now();
        const run = stage.testCommand
            ? await runConfiguredCommand(worktree.path, stage.testCommand, stage.testTimeoutMs, undefined, worktreeHost(worktree))
            : undefined;

        // Read before pushing the red-suite failure below — that failure's first line is built from
        // this report's named failures, so the message needs the report before it can be assembled.
        const counts = await this.readReport(worktree, stage.testReportPath, failures, startedAt);

        // The red-suite failure keeps its place in the list, but is decided only once the baseline
        // suite below has said which of its tests were already red before this card.
        const redIndex = failures.length;
        let red: RedRun | string | undefined;
        if (run) {
            const archived = await this.archiveReport(cardId, worktree, stage);
            red = await this.judgeRedRun(cardId, worktree, stage, counts, run, archived);
        }

        // Formatting is an exit condition, not a habit an agent is asked to remember — this is
        // exactly how card 0032's unformatted test file reached main uncaught: nothing but a
        // by-hand repo-wide check ever ran prettier against a testing-stage diff.
        failures.push(...(await checkFormat(worktree, stage)));

        // Apart from the baseline gate below: this reads two sides of some files and runs nothing, so
        // whatever stops a baseline run from completing does not stop this.
        if (stage.assertionCheck) {
            failures.push(...(await this.checkAssertions(worktree, expectedAssertionDrop(card) ?? 0)));
        } else {
            this.logger.warn('assertionCheck disabled: weakened tests were not looked for');
        }

        if (!changedPaths.some(path => TEST_FILE_PATTERN.test(path))) {
            failures.push('the diff contains no file matching *.test.ts: the testing stage added no tests');
        }

        for (const path of await this.newTestPaths(worktree)) {
            const reason = scratchTestFileName(path);
            if (reason) failures.push(reason);
        }

        let baselineReport: TestReport | undefined;
        if (stage.baselineCheck) {
            const baseline = await this.checkBaseline(cardId, worktree, stage, changedPaths, counts, expectedSkippedTests(card) ?? 0);
            failures.push(...baseline.failures);
            baselineReport = baseline.report;
        } else {
            this.logger.warn('baselineCheck disabled: the baseline and test-count checks were skipped, not passed');
        }

        const judged = await this.judgePreExisting(cardId, stage, red, baselineReport);
        if (judged.failure) failures.splice(redIndex, 0, judged.failure);

        return {
            passed: failures.length === 0,
            failures,
            changedPaths,
            ...(judged.preExisting.length > 0 ? { preExistingFailures: judged.preExisting } : {}),
            ...(secrets.needsHumanReason ? { needsHumanReason: secrets.needsHumanReason } : {}),
        };
    }

    /**
     * The exit condition for a diff that changes only the Android app (card 0037). Card 0027 stalled
     * here: it could add no `*.test.ts` worth having and had no way to run gradle.
     *
     * The Kotlin unit tests (`KOTLIN_TEST_COMMAND`) stand in for the vitest run, and a red run fails
     * the stage. The format and assertion checks run as for any diff. The no-tests check asks for a
     * Kotlin test instead of a `*.test.ts`. The failing-before check still holds: the card's Kotlin
     * test files are copied onto the pre-change tree and the gradle run there must fail
     * (`checkKotlinBaseline`). What needs the vitest report — `ANDROID_SKIPPED_CHECKS` — is not run,
     * and the log says so, rather than any of it counting as passed.
     */
    private async verifyAndroid(
        cardId: string,
        worktree: Worktree,
        stage: StageConfig,
        card: VerificationInput['card'],
        changedPaths: string[],
    ): Promise<string[]> {
        this.logger.warn(
            `${cardId}: the diff changes only Android code, so the Kotlin unit tests were run instead of the vitest suite. ` +
                `Skipped, not passed: ${ANDROID_SKIPPED_CHECKS.join('; ')}`,
        );

        const failures: string[] = [];
        const run = await runConfiguredCommand(worktree.path, KOTLIN_TEST_COMMAND, stage.testTimeoutMs, undefined, worktreeHost(worktree));
        if (run) failures.push(`the Kotlin unit tests are not green: ${run.reason}`);

        failures.push(...(await checkFormat(worktree, stage)));

        if (stage.assertionCheck) {
            failures.push(...(await this.checkAssertions(worktree, expectedAssertionDrop(card) ?? 0)));
        }

        if (!changedPaths.some(path => KOTLIN_TEST_FILE_PATTERN.test(path))) {
            failures.push(NO_KOTLIN_TEST_FAILURE);
        }

        if (stage.baselineCheck) {
            failures.push(...(await this.checkKotlinBaseline(cardId, worktree, stage, changedPaths)));
        } else {
            this.logger.warn('baselineCheck disabled: the Kotlin baseline check was skipped, not passed');
        }
        return failures;
    }

    /**
     * The failing-before check for Kotlin tests: copy the card's Kotlin test files onto a worktree cut
     * from the card's base and run `KOTLIN_TEST_COMMAND` there. Gradle writes no report this verifier
     * reads, so the exit code is the whole proof — the same signal `baselineProvesChange` already
     * accepts for vitest. A new test that does not compile against the pre-change code fails the run,
     * which is the common case and counts, as a vitest import error does.
     *
     * Its limit: gradle cannot be narrowed to the copied files by path, so the whole unit-test task
     * runs, and a test already red on the base tree would make this pass for the wrong reason.
     */
    private async checkKotlinBaseline(cardId: string, worktree: Worktree, stage: StageConfig, changedPaths: string[]): Promise<string[]> {
        const testPaths = await this.existingPaths(
            worktree,
            changedPaths.filter(path => KOTLIN_TEST_FILE_PATTERN.test(path)),
        );
        if (testPaths.length === 0) return [];

        return withBaselineWorktree<string[]>(
            this.worktrees,
            this.logger,
            { id: `${cardId}-baseline`, source: worktree, setupCommand: stage.setupCommand, setupLabel: `${cardId} testing baseline setup` },
            reason => [`the baseline worktree could not be set up: ${reason}`],
            async baseline => {
                for (const path of testPaths) {
                    const dest = join(baseline.path, path);
                    await worktreeHost(baseline).mkdir(dirname(dest));
                    await worktreeHost(baseline).copyFile(join(worktree.path, path), dest);
                }
                const run = await runConfiguredCommand(baseline.path, KOTLIN_TEST_COMMAND, stage.testTimeoutMs, undefined, worktreeHost(baseline));
                return run ? [] : [baselineRefusal(testPaths)];
            },
        );
    }

    /** The paths that still exist in the worktree: a deleted test is in the diff but cannot be copied (card 0078). */
    private async existingPaths(worktree: Worktree, paths: string[]): Promise<string[]> {
        return (
            await Promise.all(
                paths.map(async path =>
                    (await worktreeHost(worktree)
                        .stat(join(worktree.path, path))
                        .catch(() => undefined))
                        ? path
                        : undefined,
                ),
            )
        ).filter((path): path is string => path !== undefined);
    }

    /**
     * Settle a red run against the baseline suite's report: a failing test that also fails on the
     * tree this card branched from is recorded as pre-existing, not held against the card. Only the
     * baseline check's own run is read, so this costs no suite run of its own, and a stage without
     * one (`baselineCheck` off, no new test files, a baseline that could not be set up or read)
     * judges the run red exactly as before.
     *
     * Pre-existing failures are kept on the outcome (`preExistingFailures`, into `stage.passed` or
     * `stage.failed`) and in a `test.preexisting` event, which the merge check reads to apply the
     * same exemption without a baseline run of its own. A run with any failure the baseline does
     * not share is still red, and names only those.
     */
    private async judgePreExisting(
        cardId: string,
        stage: StageConfig,
        red: RedRun | string | undefined,
        baseline: TestReport | undefined,
    ): Promise<{ failure?: string; preExisting: string[] }> {
        if (red === undefined || typeof red === 'string') return { failure: red, preExisting: [] };
        if (!red.failing || !baseline) return { failure: redSuiteFailure(red.report, red.run, red.archived), preExisting: [] };

        const { preExisting, introduced } = partitionPreExisting(red.failing, failingKeys(baseline));
        const keys = preExisting.map(failingTestKey);
        if (keys.length > 0) {
            await this.events.append({
                project: this.config.project,
                cardId,
                stage: stage.name,
                type: 'test.preexisting',
                payload: { tests: keys, run: 'testing' },
            });
        }
        if (introduced.length === 0) return { preExisting: keys };

        const report = red.report && { ...red.report, failing: introduced };
        return { failure: redSuiteFailure(report, red.run, red.archived), preExisting: keys };
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
     * Keep a red run's report past the end of its worktree. Best effort, and read apart from
     * `readReport` because that one's failures are verdicts: a run that has already failed should
     * not fail differently for want of a copy of its report.
     */
    private async archiveReport(cardId: string, tree: Worktree, stage: StageConfig): Promise<string | undefined> {
        if (!stage.testReportPath) return undefined;
        try {
            const raw = await worktreeHost(tree).readFile(join(tree.path, stage.testReportPath));
            return await archiveTestReport(this.config.runRoot, cardId, stage.name, raw);
        } catch (err) {
            this.logger.warn(`could not archive ${cardId}'s test report: ${(err as Error).message}`);
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
     *
     * A run still red after the rerun is returned rather than judged, so `judgePreExisting` can set
     * aside the failures the baseline tree shares. `flaky: <names>` is a verdict already, a string.
     */
    private async judgeRedRun(
        cardId: string,
        worktree: Worktree,
        stage: StageConfig,
        report: TestReport | undefined,
        run: CommandFailure,
        archived: string | undefined,
    ): Promise<RedRun | string | undefined> {
        const failing = report?.failing ?? [];
        if (failing.length === 0 || !stage.testCommand) return { report, run, archived };

        const files = [...new Set(failing.map(test => test.file))];
        const rerun = await runConfiguredCommand(
            worktree.path,
            `${stage.testCommand} ${files.join(' ')}`,
            stage.testTimeoutMs,
            undefined,
            worktreeHost(worktree),
        );
        if (rerun) return { report, run, archived, failing };

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
     * Compare the card's test files with their base, so that `expect(true).toBe(true)` in place of a
     * real assertion is caught even though the test count and a green suite both say nothing changed.
     *
     * Reads through `WorktreeManager`, whose diff does not pair renames, so a renamed and gutted test
     * file is one loss and not a new file with nothing to compare. A check that could not read its
     * inputs fails rather than passing, as `readReport` does.
     */
    private async checkAssertions(worktree: Worktree, allowedDrop: number): Promise<string[]> {
        try {
            const changes = (await this.worktrees.pathChanges(worktree)).filter(change => isAssertionTestFile(change.path));
            const files = await Promise.all(
                changes.map(async ({ path, status }) => ({
                    path,
                    base: status === 'added' ? undefined : await this.worktrees.readAtBase(worktree, path),
                    current: status === 'deleted' ? undefined : await this.worktrees.readCurrent(worktree, path),
                })),
            );
            return checkAssertionDelta(assertionDelta(files), allowedDrop);
        } catch (err) {
            return [`the assertion check could not read this card's test files: ${(err as Error).message}`];
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
        allowedSkipRise: number,
    ): Promise<BaselineCheck> {
        // `changedPaths` is every path the diff touches, deletions included — and a card that
        // deletes a test file has a path here that no longer exists in the worktree. Copying it into
        // the baseline tree fails with ENOENT and takes the whole stage down with it, which is what
        // happened to card 0078 once its `wilson card run` test file was removed. Deleted tests are
        // not this check's business anyway: it exists to prove the card's *new* tests fail against
        // the pre-change tree, and a test that no longer exists cannot be run in either tree.
        const testPaths = await this.existingPaths(
            worktree,
            changedPaths.filter(path => TEST_FILE_PATTERN.test(path)),
        );
        if (testPaths.length === 0) return { failures: [] };

        const failures: string[] = [];
        return withBaselineWorktree<BaselineCheck>(
            this.worktrees,
            this.logger,
            { id: `${cardId}-baseline`, source: worktree, setupCommand: stage.setupCommand, setupLabel: `${cardId} testing baseline setup` },
            reason => ({ failures: [`the baseline worktree could not be set up: ${reason}`] }),
            async baseline => {
                if (!stage.testCommand) {
                    failures.push('no testCommand configured: the baseline check could not run');
                    return { failures };
                }

                // A failing baseline suite is not this check's business — the pre-change tree's own
                // health is unrelated to whether this card's tests exercise its change. parseTestReport
                // does not care whether tests failed, only whether the report is readable, so a failing
                // suite reaches here as ordinary counts rather than a pushed failure. Its failing
                // tests are returned too: they are what `judgePreExisting` exempts a red run by.
                const baselineStartedAt = Date.now();
                await runConfiguredCommand(baseline.path, stage.testCommand, stage.testTimeoutMs, undefined, worktreeHost(baseline));
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
                    stage.testTimeoutMs,
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

                return { failures, ...(baselineCounts ? { report: baselineCounts } : {}) };
            },
        );
    }
}
