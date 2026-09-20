import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    baselineProvesChange,
    baselineRefusal,
    checkCounts,
    describeFailingTest,
    redSuiteFailure,
    scratchTestFileName,
    TestingVerifier,
} from '#modules/stages/testing.verifier.js';
import { parseTestReport, type FailingTest, type TestReport } from '#modules/stages/test.report.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { ScopeGuard } from '#modules/agent/scope.guard.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const makeStage = (overrides: Partial<StageConfig> = {}): StageConfig => ({
    name: 'testing',
    mode: 'agent',
    worktree: 'rw',
    provider: 'anthropic',
    model: 'claude-opus',
    instructions: 'test the thing',
    allowedCommands: [],
    worktreeFrom: 'branch',
    extraScope: [],
    baselineCheck: false,
    maxSteps: 60,
    maxOutputTokens: 16000,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
    ...overrides,
});

describe('parseTestReport', () => {
    it('reads a valid vitest JSON report', () => {
        const raw = JSON.stringify({
            numTotalTests: 10,
            numPassedTests: 8,
            numFailedTests: 0,
            numPendingTests: 1,
            numTodoTests: 1,
        });

        expect(parseTestReport(raw)).toEqual({ total: 10, passed: 8, failed: 0, skipped: 2 });
    });

    it('throws on malformed JSON', () => {
        expect(() => parseTestReport('{ not json')).toThrow(/not valid JSON/);
    });

    it('throws when a required numeric field is missing', () => {
        const raw = JSON.stringify({
            numTotalTests: 10,
            numPassedTests: 10,
            numFailedTests: 0,
            numPendingTests: 0,
            // numTodoTests missing
        });

        expect(() => parseTestReport(raw)).toThrow(/numTodoTests/);
    });

    it('throws when a field is present but not a number', () => {
        const raw = JSON.stringify({
            numTotalTests: '10',
            numPassedTests: 10,
            numFailedTests: 0,
            numPendingTests: 0,
            numTodoTests: 0,
        });

        expect(() => parseTestReport(raw)).toThrow(/numTotalTests/);
    });

    // Card 0246: naming which tests failed, added on top of the counts check above.
    describe('failing tests (card 0246)', () => {
        it('names a failed assertion, with the file made relative to worktreePath', () => {
            const raw = JSON.stringify({
                numTotalTests: 1,
                numPassedTests: 0,
                numFailedTests: 1,
                numPendingTests: 0,
                numTodoTests: 0,
                testResults: [
                    {
                        name: '/repo/apps/api/tests/thing.test.ts',
                        status: 'failed',
                        assertionResults: [{ status: 'failed', fullName: 'thing does the correct thing' }],
                    },
                ],
            });

            const report = parseTestReport(raw, '/repo');

            expect(report.failing).toEqual([{ file: 'apps/api/tests/thing.test.ts', name: 'thing does the correct thing' }]);
            // The counts stay exactly what they were before this card — the failing list is additive.
            expect(report).toMatchObject({ total: 1, passed: 0, failed: 1, skipped: 0 });
        });

        it('names every failed assertion in a file with more than one', () => {
            const raw = JSON.stringify({
                numTotalTests: 2,
                numPassedTests: 0,
                numFailedTests: 2,
                numPendingTests: 0,
                numTodoTests: 0,
                testResults: [
                    {
                        name: '/repo/thing.test.ts',
                        status: 'failed',
                        assertionResults: [
                            { status: 'failed', fullName: 'thing does the first correct thing' },
                            { status: 'passed', fullName: 'thing does an unrelated thing' },
                            { status: 'failed', fullName: 'thing does the second correct thing' },
                        ],
                    },
                ],
            });

            expect(parseTestReport(raw, '/repo').failing).toEqual([
                { file: 'thing.test.ts', name: 'thing does the first correct thing' },
                { file: 'thing.test.ts', name: 'thing does the second correct thing' },
            ]);
        });

        it('names a file that failed to load with the first line of its own message, and no test name', () => {
            const raw = JSON.stringify({
                numTotalTests: 0,
                numPassedTests: 0,
                numFailedTests: 1,
                numPendingTests: 0,
                numTodoTests: 0,
                testResults: [
                    {
                        name: '/repo/broken.test.ts',
                        status: 'failed',
                        assertionResults: [],
                        message: "Cannot find module './missing.js'\n    at Object.<anonymous> (/repo/broken.test.ts:1:1)",
                    },
                ],
            });

            expect(parseTestReport(raw, '/repo').failing).toEqual([
                { file: 'broken.test.ts', name: undefined, message: "Cannot find module './missing.js'" },
            ]);
        });

        it('omits `failing` entirely when nothing failed, so an unchanged report stays structurally identical', () => {
            const raw = JSON.stringify({
                numTotalTests: 3,
                numPassedTests: 3,
                numFailedTests: 0,
                numPendingTests: 0,
                numTodoTests: 0,
                testResults: [{ name: '/repo/ok.test.ts', status: 'passed', assertionResults: [{ status: 'passed', fullName: 'ok' }] }],
            });

            expect(parseTestReport(raw, '/repo')).toEqual({ total: 3, passed: 3, failed: 0, skipped: 0 });
        });

        it('yields an empty failing list, rather than throwing, when testResults is missing or malformed', () => {
            const withoutTestResults = JSON.stringify({
                numTotalTests: 1,
                numPassedTests: 0,
                numFailedTests: 1,
                numPendingTests: 0,
                numTodoTests: 0,
            });
            expect(parseTestReport(withoutTestResults, '/repo').failing).toBeUndefined();

            const malformed = JSON.stringify({
                numTotalTests: 1,
                numPassedTests: 0,
                numFailedTests: 1,
                numPendingTests: 0,
                numTodoTests: 0,
                testResults: 'not an array',
            });
            expect(() => parseTestReport(malformed, '/repo')).not.toThrow();
            expect(parseTestReport(malformed, '/repo').failing).toBeUndefined();

            const entryWithoutAName = JSON.stringify({
                numTotalTests: 1,
                numPassedTests: 0,
                numFailedTests: 1,
                numPendingTests: 0,
                numTodoTests: 0,
                testResults: [{ status: 'failed' }],
            });
            expect(parseTestReport(entryWithoutAName, '/repo').failing).toBeUndefined();
        });

        it('still throws on a report missing a count field, even when testResults is present (AC5)', () => {
            const raw = JSON.stringify({
                numTotalTests: 1,
                numPassedTests: 0,
                numFailedTests: 1,
                numPendingTests: 0,
                // numTodoTests missing
                testResults: [{ name: '/repo/thing.test.ts', status: 'failed', assertionResults: [{ status: 'failed', fullName: 'x' }] }],
            });

            expect(() => parseTestReport(raw, '/repo')).toThrow(/numTodoTests/);
        });
    });
});

describe('checkCounts', () => {
    const counts = { total: 10, passed: 10, failed: 0, skipped: 0 };

    it('passes when counts equal the baseline', () => {
        expect(checkCounts(counts, { total: 10, skipped: 0 })).toEqual([]);
    });

    it('fails when the total dropped', () => {
        const failures = checkCounts(counts, { total: 12, skipped: 0 });
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatch(/dropped from 12 to 10/);
    });

    it('fails when the skipped count rose', () => {
        const failures = checkCounts({ ...counts, skipped: 3 }, { total: 10, skipped: 1 });
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatch(/rose from 1 to 3/);
    });

    it('skips both checks without failing when baselineCounts is absent', () => {
        expect(checkCounts(counts, undefined)).toEqual([]);
        expect(checkCounts({ ...counts, total: 0, skipped: 100 }, undefined)).toEqual([]);
    });

    /**
     * Card 0232: `checkCounts` takes an optional `allowedSkipRise`, a ceiling on how much the
     * skipped count may rise rather than an exact match, sourced from the plan's declared
     * `expectedSkippedTests` (card.ts). Every case above calls `checkCounts` with only two
     * arguments, so `allowedSkipRise` defaults to 0 — today's rule, unchanged.
     */
    describe('allowedSkipRise (card 0232)', () => {
        it('AC2: a rise up to the declared ceiling produces no failure', () => {
            const failures = checkCounts({ ...counts, skipped: 6 }, { total: 10, skipped: 0 }, 6);
            expect(failures).toEqual([]);
        });

        it('AC3: a rise past the declared ceiling fails, naming both counts and the declared ceiling', () => {
            const failures = checkCounts({ ...counts, skipped: 7 }, { total: 10, skipped: 0 }, 6);
            expect(failures).toHaveLength(1);
            expect(failures[0]).toMatch(/rose from 0 to 7/);
            expect(failures[0]).toMatch(/more than the 6/);
            expect(failures[0]).toMatch(/this plan declares/);
        });

        it('AC4: with no ceiling passed, a rise from 0 to 1 fails with exactly today\'s message', () => {
            const failures = checkCounts({ ...counts, skipped: 1 }, { total: 10, skipped: 0 });
            expect(failures).toEqual(['the skipped-test count rose from 0 to 1: tests were skipped rather than fixed']);
        });

        it('AC5: a declared ceiling never excuses a drop in the total test count', () => {
            const failures = checkCounts({ ...counts, total: 8, skipped: 6 }, { total: 10, skipped: 0 }, 6);
            expect(failures).toHaveLength(1);
            expect(failures[0]).toMatch(/dropped from 10 to 8/);
        });
    });
});

describe('describeFailingTest', () => {
    it('formats an ordinary failed assertion as "<file> > <fullName>"', () => {
        expect(describeFailingTest({ file: 'apps/api/tests/thing.test.ts', name: 'thing does the correct thing' })).toBe(
            'apps/api/tests/thing.test.ts > thing does the correct thing',
        );
    });

    it('formats a file that failed to load as "<file> failed to load: <message>"', () => {
        expect(describeFailingTest({ file: 'broken.test.ts', name: undefined, message: "Cannot find module './missing.js'" })).toBe(
            "broken.test.ts failed to load: Cannot find module './missing.js'",
        );
    });

    it('falls back to "no message" for a load failure with no message', () => {
        expect(describeFailingTest({ file: 'broken.test.ts', name: undefined })).toBe('broken.test.ts failed to load: no message');
    });
});

/**
 * Card 0246: the red-suite failure's first line names which tests failed, since that first line is
 * the only part the board's event log and card 0234's attempt record keep. `checkCounts` above is
 * the strict exit condition; this is purely about what the message says when the suite is red.
 */
describe('redSuiteFailure', () => {
    const run = { reason: '`pnpm exec vitest run` failed (exit 1)\nsome noisy console output' };
    const report = (failing: FailingTest[]): TestReport => ({ total: failing.length, passed: 0, failed: failing.length, skipped: 0, failing });

    it('AC1: names both failed assertions on the first line, and keeps the exit reason on later lines', () => {
        const message = redSuiteFailure(
            report([
                { file: 'a.test.ts', name: 'a does the thing' },
                { file: 'b.test.ts', name: 'b does the other thing' },
            ]),
            run,
        );

        const [firstLine, ...rest] = message.split('\n');
        expect(firstLine).toBe('the suite is not green: 2 failing: a.test.ts > a does the thing; b.test.ts > b does the other thing');
        expect(rest.join('\n')).toContain(run.reason);
    });

    it('AC2: names five of seven failures on the first line, and ends it with "and 2 more"', () => {
        const failing = Array.from({ length: 7 }, (_, i) => ({ file: `f${i}.test.ts`, name: `case ${i}` }));

        const [firstLine] = redSuiteFailure(report(failing), run).split('\n');

        expect(firstLine).toBe(
            'the suite is not green: 7 failing: f0.test.ts > case 0; f1.test.ts > case 1; f2.test.ts > case 2; ' +
                'f3.test.ts > case 3; f4.test.ts > case 4 and 2 more',
        );
    });

    it('AC3: names a file that failed to load with the first line of its message', () => {
        const [firstLine] = redSuiteFailure(report([{ file: 'broken.test.ts', name: undefined, message: "Cannot find module './x.js'" }]), run).split(
            '\n',
        );

        expect(firstLine).toBe("the suite is not green: 1 failing: broken.test.ts failed to load: Cannot find module './x.js'");
    });

    it('AC4: falls back to today\'s plain message when there is no report at all', () => {
        expect(redSuiteFailure(undefined, run)).toBe(`the suite is not green: ${run.reason}`);
    });

    it('AC4: falls back to today\'s plain message when the report parsed but named no failures', () => {
        expect(redSuiteFailure({ total: 0, passed: 0, failed: 0, skipped: 0 }, run)).toBe(`the suite is not green: ${run.reason}`);
    });
});

describe('baselineProvesChange', () => {
    // The case that matters, measured rather than assumed: a new test that cannot import the
    // code it tests makes vitest exit 1 *and* write a parseable report saying numFailedTests: 0,
    // because a collection error is not a failed test. Reading the report as authoritative
    // whenever it parsed made the first real run report that the tests passed against the
    // pre-change tree when they had never run there at all.
    it('trusts a non-zero exit even when the report parsed and counted no failures', () => {
        expect(baselineProvesChange({ total: 0, passed: 0, failed: 0, skipped: 0 }, true)).toBe(true);
    });

    it('rejects a clean exit with no failures, which is a test that proves nothing', () => {
        expect(baselineProvesChange({ total: 4, passed: 4, failed: 0, skipped: 0 }, false)).toBe(false);
    });

    it('passes when the baseline run had at least one failure', () => {
        expect(baselineProvesChange({ total: 1, passed: 0, failed: 1, skipped: 0 }, false)).toBe(true);
    });

    it('fails when the baseline run had zero failures', () => {
        expect(baselineProvesChange({ total: 1, passed: 1, failed: 0, skipped: 0 }, false)).toBe(false);
    });

    it('passes on a non-zero exit with no parseable report — a test that fails to even import', () => {
        expect(baselineProvesChange(undefined, true)).toBe(true);
    });

    it('fails on a zero exit with no parseable report', () => {
        expect(baselineProvesChange(undefined, false)).toBe(false);
    });
});

describe('scratchTestFileName', () => {
    it('rejects a leading underscore', () => {
        const reason = scratchTestFileName('apps/api/tests/modules/jobs/__scratch.faketimer.test.ts');
        expect(reason).toMatch(/__scratch\.faketimer\.test\.ts/);
        expect(reason).toMatch(/rename it/);
    });

    it('rejects a tmp prefix', () => {
        expect(scratchTestFileName('apps/web/tests/__tmp_tone.test.ts')).toBeDefined();
    });

    it('rejects a scratch prefix', () => {
        expect(scratchTestFileName('scratch.foo.test.ts')).toBeDefined();
    });

    it('rejects a temp prefix, dash-separated', () => {
        expect(scratchTestFileName('temp-thing.test.ts')).toBeDefined();
    });

    it('is case-insensitive about the prefix', () => {
        expect(scratchTestFileName('TMP_thing.test.ts')).toBeDefined();
    });

    it('judges the basename, not the whole path', () => {
        // A directory named "tmp" is not the file's own name.
        expect(scratchTestFileName('tmp/shutdown.faketimer.test.ts')).toBeUndefined();
    });

    it('passes a name that merely starts with the same letters as a banned word', () => {
        // "temporary" and "scratchpad" are real words a unit under test could be named after —
        // the check must not fire on a mere prefix match.
        expect(scratchTestFileName('temporary.test.ts')).toBeUndefined();
        expect(scratchTestFileName('scratchpad.test.ts')).toBeUndefined();
    });

    it('passes the repo convention: lowercase, dot- or dash-separated, named for the unit under test', () => {
        expect(scratchTestFileName('shutdown.faketimer.test.ts')).toBeUndefined();
        expect(scratchTestFileName('tone.test.ts')).toBeUndefined();
        expect(scratchTestFileName('board.test.ts')).toBeUndefined();
        expect(scratchTestFileName('card.parser.test.ts')).toBeUndefined();
        expect(scratchTestFileName('stage.dispatcher.budget.test.ts')).toBeUndefined();
    });

    /**
     * The rule has to hold against the suite as it actually stands, not just the handful of
     * examples above — if any existing file tripped it, the rule would be wrong, not the file
     * (plan task 3). Walks apps/api/tests and apps/web/tests for real rather than hard-coding the
     * list, so a file added after this test was written is still covered.
     */
    it('every test file currently in the repo satisfies the rule', async () => {
        const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
        const testDirs = [join(repoRoot, 'apps', 'api', 'tests'), join(repoRoot, 'apps', 'web', 'tests')];

        const walk = async (dir: string): Promise<string[]> => {
            const entries = await readdir(dir, { withFileTypes: true });
            const files = await Promise.all(
                entries.map(async entry => {
                    const full = join(dir, entry.name);
                    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
                    return entry.name.endsWith('.test.ts') ? [full] : [];
                }),
            );
            return files.flat();
        };

        const found = (await Promise.all(testDirs.map(walk))).flat();
        expect(found.length).toBeGreaterThan(0);

        const offenders = found.filter(path => scratchTestFileName(path) !== undefined);
        expect(offenders).toEqual([]);
    });
});

/**
 * Exercises `TestingVerifier.verify` against a real git worktree, the way `WorktreeManager`'s own
 * tests do, rather than mocking `git` — the check being tested is precisely which files git reports
 * as added versus merely present, and a mock would only prove the test agrees with itself about
 * that.
 */
describe('TestingVerifier — scratch-named test files', () => {
    let codeRoot: string;
    let manager: WorktreeManager;
    let verifier: TestingVerifier;
    const stage = makeStage();
    const verifyInput = (worktree: Awaited<ReturnType<WorktreeManager['create']>>) => ({
        worktree,
        stage,
        cardId: '0001',
        scope: {} as ScopeGuard,
        result: undefined,
    });

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'testing-verifier-'));
        codeRoot = join(base, 'code');
        await mkdir(join(codeRoot, 'tests'), { recursive: true });

        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        // A pre-existing, badly-named file already on the base — this card did not add it, so the
        // check must leave it alone even when the stage touches it.
        await writeFile(join(codeRoot, 'tests', 'tmp_legacy.test.ts'), "it('old', () => {});\n", 'utf8');
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
        manager = new WorktreeManager(config, silentLogger as never);
        verifier = new TestingVerifier(manager, silentLogger as never);
    });

    it('fails on a scratch-named file the stage wrote but never staged, naming it and the reason', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await writeFile(join(worktree.path, 'tests', '__scratch.foo.test.ts'), "it('x', () => {});\n", 'utf8');

        const outcome = await verifier.verify(verifyInput(worktree));

        expect(outcome.passed).toBe(false);
        const hit = outcome.failures.find(f => f.includes('tests/__scratch.foo.test.ts'));
        expect(hit).toBeDefined();
        expect(hit).toMatch(/rename it/);
    });

    it('fails on a scratch-named file already committed on the branch, from an earlier attempt', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await writeFile(join(worktree.path, 'tests', '__scratch.bar.test.ts'), "it('x', () => {});\n", 'utf8');
        await exec('git', ['add', '-A'], { cwd: worktree.path });
        await exec('git', ['commit', '-q', '-m', 'earlier attempt'], { cwd: worktree.path });

        const outcome = await verifier.verify(verifyInput(worktree));

        expect(outcome.failures.some(f => f.includes('tests/__scratch.bar.test.ts'))).toBe(true);
    });

    it('does not flag a properly-named test file the stage adds', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await writeFile(join(worktree.path, 'tests', 'shutdown.faketimer.test.ts'), "it('x', () => {});\n", 'utf8');

        const outcome = await verifier.verify(verifyInput(worktree));

        expect(outcome.failures.some(f => f.includes('shutdown.faketimer.test.ts'))).toBe(false);
    });

    it('does not flag a pre-existing badly-named file the stage only modifies', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await writeFile(join(worktree.path, 'tests', 'tmp_legacy.test.ts'), "it('old', () => { expect(1).toBe(1); });\n", 'utf8');

        const outcome = await verifier.verify(verifyInput(worktree));

        expect(outcome.failures.some(f => f.includes('tmp_legacy.test.ts'))).toBe(false);
    });
});

/**
 * Card 0041: `TestingVerifier.verify` now runs `checkFormat` (`stage.verifier.ts`) too — the same
 * exit condition `ImplementingVerifier` runs, so the testing stage cannot commit an unformatted
 * test file the way card 0032's `board.service.test.ts` did. `testCommand`/`testReportPath` are
 * left unset and `baselineCheck` off so `verify` does only the work these tests are about; the
 * other checks it also runs are free to add their own failures alongside — these tests only assert
 * on what happens to the format-specific one.
 */
describe('TestingVerifier — format check (card 0041)', () => {
    let base: string;
    let manager: WorktreeManager;
    let verifier: TestingVerifier;
    let prettierBin: string;

    beforeEach(async () => {
        const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
        prettierBin = join(repoRoot, 'node_modules', '.bin', 'prettier');

        base = await mkdtemp(join(tmpdir(), 'testing-verifier-format-'));
        const codeRoot = join(base, 'code');
        await mkdir(codeRoot, { recursive: true });

        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await writeFile(join(codeRoot, 'README.md'), '# base\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
        manager = new WorktreeManager(config, silentLogger as never);
        verifier = new TestingVerifier(manager, silentLogger as never);
    });

    afterEach(async () => {
        await rm(base, { recursive: true, force: true }).catch(() => undefined);
    });

    const verifyInput = (worktree: Awaited<ReturnType<WorktreeManager['create']>>, stage: StageConfig) => ({
        worktree,
        stage,
        cardId: '0001',
        scope: {} as ScopeGuard,
        result: undefined,
    });

    it('fails and names the file when the testing stage leaves something prettier would reformat', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await mkdir(join(worktree.path, 'tests'), { recursive: true });
        await writeFile(join(worktree.path, 'tests', 'bad.test.ts'), "it('x',()=>{  expect(1).toBe(1) })\n", 'utf8');

        const stage = makeStage({
            testCommand: undefined,
            testReportPath: undefined,
            baselineCheck: false,
            formatCommand: `${prettierBin} --check .`,
        });
        const outcome = await verifier.verify(verifyInput(worktree, stage));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('bad.test.ts'))).toBe(true);
    });

    it('does not flag formatting once the testing stage’s new file is actually formatted', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await mkdir(join(worktree.path, 'tests'), { recursive: true });
        await writeFile(join(worktree.path, 'tests', 'good.test.ts'), "it('x',()=>{  expect(1).toBe(1) })\n", 'utf8');
        // Normalise with the real formatter rather than hand-typing what "already formatted" looks
        // like — the point is that *prettier's own opinion* is satisfied, not a guess at it.
        await exec(prettierBin, ['--write', '.'], { cwd: worktree.path });

        const stage = makeStage({
            testCommand: undefined,
            testReportPath: undefined,
            baselineCheck: false,
            formatCommand: `${prettierBin} --check .`,
        });
        const outcome = await verifier.verify(verifyInput(worktree, stage));

        expect(outcome.failures.some(f => f.includes('good.test.ts'))).toBe(false);
    });

    it('runs no format check at all when formatCommand is not configured, even on an unformatted new test file', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await mkdir(join(worktree.path, 'tests'), { recursive: true });
        await writeFile(join(worktree.path, 'tests', 'bad.test.ts'), "it('x',()=>{  expect(1).toBe(1) })\n", 'utf8');

        const stage = makeStage({ testCommand: undefined, testReportPath: undefined, baselineCheck: false });
        const outcome = await verifier.verify(verifyInput(worktree, stage));

        expect(outcome.failures.some(f => f.includes('bad.test.ts'))).toBe(false);
    });
});

/**
 * Card 0246, end to end: `TestingVerifier.verify` itself, not just `redSuiteFailure` in isolation,
 * reads the report before it pushes the red-suite failure and builds that failure's first line from
 * the report's named failures. `testCommand` here is a small script rather than a real vitest run —
 * it writes a report shaped exactly like the one vitest's JSON reporter would, then exits non-zero
 * the way a red suite does — so the test is about the wiring in `verify`, not about vitest itself.
 */
describe('TestingVerifier — red-suite failure names failing tests (card 0246)', () => {
    let base: string;
    let manager: WorktreeManager;
    let verifier: TestingVerifier;

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'testing-verifier-redsuite-'));
        const codeRoot = join(base, 'code');
        await mkdir(codeRoot, { recursive: true });

        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await writeFile(join(codeRoot, 'README.md'), '# base\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
        manager = new WorktreeManager(config, silentLogger as never);
        verifier = new TestingVerifier(manager, silentLogger as never);
    });

    afterEach(async () => {
        await rm(base, { recursive: true, force: true }).catch(() => undefined);
    });

    const verifyInput = (worktree: Awaited<ReturnType<WorktreeManager['create']>>, stage: StageConfig) => ({
        worktree,
        stage,
        cardId: '0001',
        scope: {} as ScopeGuard,
        result: undefined,
    });

    it('leads the red-suite failure with the failing test names, ahead of the command exit reason', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await mkdir(join(worktree.path, 'tests'), { recursive: true });
        await writeFile(join(worktree.path, 'tests', 'thing.test.ts'), "it('x', () => {});\n", 'utf8');

        const reportPath = join(worktree.path, 'report.json');
        const report = {
            numTotalTests: 1,
            numPassedTests: 0,
            numFailedTests: 1,
            numPendingTests: 0,
            numTodoTests: 0,
            testResults: [
                {
                    name: join(worktree.path, 'tests', 'thing.test.ts'),
                    status: 'failed',
                    assertionResults: [{ status: 'failed', fullName: 'thing does the correct thing' }],
                },
            ],
        };
        // No shell is involved in running a configured command (`runConfiguredCommand` execs the
        // file directly), so the fake "suite" is a script rather than an inline `-e` string with
        // spaces in it — those would be split apart as separate argv entries.
        await writeFile(
            join(worktree.path, 'fake-suite.cjs'),
            `require('fs').writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});\nprocess.exit(1);\n`,
            'utf8',
        );

        const stage = makeStage({
            testCommand: `node ${join(worktree.path, 'fake-suite.cjs')}`,
            testReportPath: 'report.json',
            baselineCheck: false,
        });

        const outcome = await verifier.verify(verifyInput(worktree, stage));

        expect(outcome.passed).toBe(false);
        const redSuite = outcome.failures.find(f => f.startsWith('the suite is not green:'));
        expect(redSuite).toBeDefined();

        const [firstLine, ...rest] = (redSuite as string).split('\n');
        expect(firstLine).toBe('the suite is not green: 1 failing: tests/thing.test.ts > thing does the correct thing');
        expect(rest.join('\n')).toMatch(/failed \(exit 1\)/);
    });
});

/**
 * Card 0184, decided 2026-09-02: accepted. The baseline check stays exactly as strict — it is what
 * separates a real test from one that passes vacuously, and it caught real bugs on cards 0168 and
 * 0178. What changes is that the refusal now names the one case it cannot judge.
 *
 * A regression guard over behaviour an earlier card already fixed cannot fail against the
 * pre-change tree, because that tree already contains the fix. Card 0180 spent three kickbacks and
 * a human flag discovering that. The message is the deliverable of the decision, so it is asserted
 * rather than left to prose: every case here fails on the pre-change tree, where the refusal said
 * only that the tests proved nothing.
 */
describe('baselineRefusal', () => {
    it('still says plainly what the check found', () => {
        const message = baselineRefusal(['apps/web/tests/link-contrast.test.ts']);

        expect(message).toContain('pass against the pre-change tree');
        expect(message).toContain('apps/web/tests/link-contrast.test.ts');
    });

    it('names the guard case, so a card that cannot pass is not rewritten three times trying', () => {
        const message = baselineRefusal(['a.test.ts']);

        expect(message).toContain('regression guard');
        expect(message).toContain('no rewrite will change that');
    });

    it('names the manual proof and the way out, not just the problem', () => {
        const message = baselineRefusal(['a.test.ts']);

        expect(message).toContain('removing what it guards');
        expect(message).toContain('ack and move the card on');
    });

    it('lists every path it was given', () => {
        expect(baselineRefusal(['a.test.ts', 'b.test.ts'])).toContain('a.test.ts, b.test.ts');
    });
});

/**
 * Card 0261. `TestingVerifier` now takes `EventLog` and `BoardConfig` too, so a red run can rerun
 * just the files a report names as failing, append a `test.flaky` event on a green rerun, and treat
 * the suite as green — unless the card already carries a `test.flaky` event naming one of the same
 * tests, in which case recurrence itself fails the run. `events` here is a plain in-memory stand-in
 * rather than a real `EventLog`: nothing under test reads from Postgres, only from `append`/`tail`'s
 * own contract.
 */
describe('TestingVerifier — flaky rerun (card 0261)', () => {
    let base: string;
    let manager: WorktreeManager;
    let config: StaticBoardConfig;
    let events: {
        rows: Array<{ project: string; cardId: string; stage?: string; type: string; payload: Record<string, unknown> }>;
        append: ReturnType<typeof vi.fn>;
        tail: ReturnType<typeof vi.fn>;
    };
    let verifier: TestingVerifier;

    const fakeEvents = () => {
        const rows: Array<{ project: string; cardId: string; stage?: string; type: string; payload: Record<string, unknown> }> = [];
        return {
            rows,
            append: vi.fn(async (event: { project: string; cardId: string; stage?: string; type: string; payload?: Record<string, unknown> }) => {
                rows.push({ ...event, payload: event.payload ?? {} });
            }),
            tail: vi.fn(async (project: string, cardId: string) =>
                rows
                    .filter(r => r.project === project && r.cardId === cardId)
                    .map(r => ({ id: '1', stage: r.stage ?? null, type: r.type, payload: r.payload, createdAt: undefined })),
            ),
        };
    };

    /**
     * A fake `stage.testCommand`: logs every invocation's extra argv to `calls.log` (one JSON line
     * per call, so a test can prove exactly how many times — and with what file args — the command
     * ran), writes a report naming `opts.tests` as failing on the *first* call (no extra args), then
     * exits `opts.firstExit` (default 1). Any call made *with* extra args — the rerun — instead exits
     * `opts.rerunExit` (default 0) without touching the report, since `judgeRedRun` never re-reads it.
     */
    const writeFakeSuite = async (
        worktreePath: string,
        opts: { reportPath: string; tests: Array<{ file: string; name: string }>; firstExit?: number; rerunExit?: number },
    ): Promise<string> => {
        const firstExit = opts.firstExit ?? 1;
        const rerunExit = opts.rerunExit ?? 0;
        const report = {
            numTotalTests: opts.tests.length,
            numPassedTests: 0,
            numFailedTests: opts.tests.length,
            numPendingTests: 0,
            numTodoTests: 0,
            testResults: opts.tests.map(t => ({
                name: join(worktreePath, t.file),
                status: 'failed',
                assertionResults: [{ status: 'failed', fullName: t.name }],
            })),
        };
        const scriptPath = join(worktreePath, 'fake-suite.cjs');
        const body = [
            "const fs = require('fs');",
            `fs.appendFileSync(${JSON.stringify(join(worktreePath, 'calls.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
            'if (process.argv.length > 2) {',
            `  process.exit(${rerunExit});`,
            '}',
            `fs.writeFileSync(${JSON.stringify(join(worktreePath, opts.reportPath))}, ${JSON.stringify(JSON.stringify(report))});`,
            `process.exit(${firstExit});`,
        ].join('\n');
        await writeFile(scriptPath, body, 'utf8');
        return scriptPath;
    };

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'testing-verifier-flaky-'));
        const codeRoot = join(base, 'code');
        await mkdir(codeRoot, { recursive: true });

        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await writeFile(join(codeRoot, 'README.md'), '# base\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
        manager = new WorktreeManager(config, silentLogger as never);
        events = fakeEvents();
        verifier = new TestingVerifier(manager, silentLogger as never, events as unknown as EventLog, config);
    });

    afterEach(async () => {
        await rm(base, { recursive: true, force: true }).catch(() => undefined);
    });

    const verifyInput = (worktree: Awaited<ReturnType<WorktreeManager['create']>>, stage: StageConfig) => ({
        worktree,
        stage,
        cardId: '0001',
        scope: {} as ScopeGuard,
        result: undefined,
    });

    it('AC1: a red run whose rerun of the failed file is green appends one test.flaky event naming it, and the suite is judged green', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await mkdir(join(worktree.path, 'tests'), { recursive: true });
        await writeFile(join(worktree.path, 'tests', 'thing.test.ts'), "it('x', () => {});\n", 'utf8');

        const scriptPath = await writeFakeSuite(worktree.path, {
            reportPath: 'report.json',
            tests: [{ file: 'tests/thing.test.ts', name: 'flaky test' }],
        });

        const stage = makeStage({ testCommand: `node ${scriptPath}`, testReportPath: 'report.json', baselineCheck: false });
        const outcome = await verifier.verify(verifyInput(worktree, stage));

        expect(outcome.passed).toBe(true);
        expect(outcome.failures).toEqual([]);
        expect(events.append).toHaveBeenCalledTimes(1);
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'test.flaky',
                payload: { tests: ['tests/thing.test.ts > flaky test'], run: 'testing' },
            }),
        );
    });

    it('AC2: a red run whose rerun is also red fails with today\'s message, and appends no test.flaky event', async () => {
        const worktree = await manager.create('0002', 'card/0002-thing');
        await mkdir(join(worktree.path, 'tests'), { recursive: true });
        await writeFile(join(worktree.path, 'tests', 'thing.test.ts'), "it('x', () => {});\n", 'utf8');

        const scriptPath = await writeFakeSuite(worktree.path, {
            reportPath: 'report.json',
            tests: [{ file: 'tests/thing.test.ts', name: 'still broken' }],
            rerunExit: 1,
        });

        const stage = makeStage({ testCommand: `node ${scriptPath}`, testReportPath: 'report.json', baselineCheck: false });
        const outcome = await verifier.verify(verifyInput(worktree, stage));

        expect(outcome.passed).toBe(false);
        const redSuite = outcome.failures.find(f => f.startsWith('the suite is not green:'));
        expect(redSuite).toBeDefined();
        expect(redSuite).toContain('tests/thing.test.ts > still broken');
        expect(events.append).not.toHaveBeenCalled();

        // Proves the rerun actually ran, not just that the outcome matches today's.
        const calls = (await readFile(join(worktree.path, 'calls.log'), 'utf8')).trim().split('\n');
        expect(calls).toHaveLength(2);
    });

    it('AC3: a red run whose report names no failing tests is judged red with no rerun attempted', async () => {
        const worktree = await manager.create('0003', 'card/0003-thing');
        await mkdir(join(worktree.path, 'tests'), { recursive: true });
        await writeFile(join(worktree.path, 'tests', 'thing.test.ts'), "it('x', () => {});\n", 'utf8');

        // Crashes before writing a report at all — nothing for `judgeRedRun` to name, so there is
        // nothing to rerun.
        const scriptPath = join(worktree.path, 'fake-suite.cjs');
        await writeFile(
            scriptPath,
            [
                "const fs = require('fs');",
                `fs.appendFileSync(${JSON.stringify(join(worktree.path, 'calls.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
                'process.exit(1);',
            ].join('\n'),
            'utf8',
        );

        const stage = makeStage({ testCommand: `node ${scriptPath}`, testReportPath: 'report.json', baselineCheck: false });
        const outcome = await verifier.verify(verifyInput(worktree, stage));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.startsWith('the suite is not green:'))).toBe(true);
        expect(events.append).not.toHaveBeenCalled();

        const calls = (await readFile(join(worktree.path, 'calls.log'), 'utf8')).trim().split('\n');
        expect(calls).toHaveLength(1);
    });

    it('AC4: the rerun runs stage.testCommand with only the failing files\' paths appended, deduplicated', async () => {
        const worktree = await manager.create('0004', 'card/0004-thing');
        await mkdir(join(worktree.path, 'tests'), { recursive: true });
        await writeFile(join(worktree.path, 'tests', 'thing.test.ts'), "it('x', () => {});\n", 'utf8');
        await writeFile(join(worktree.path, 'tests', 'other.test.ts'), "it('y', () => {});\n", 'utf8');

        const scriptPath = await writeFakeSuite(worktree.path, {
            reportPath: 'report.json',
            tests: [
                { file: 'tests/thing.test.ts', name: 'case a' },
                { file: 'tests/thing.test.ts', name: 'case b' },
                { file: 'tests/other.test.ts', name: 'case c' },
            ],
        });

        const stage = makeStage({ testCommand: `node ${scriptPath}`, testReportPath: 'report.json', baselineCheck: false });
        await verifier.verify(verifyInput(worktree, stage));

        const calls = (await readFile(join(worktree.path, 'calls.log'), 'utf8')).trim().split('\n');
        expect(calls).toHaveLength(2);
        expect(JSON.parse(calls[0])).toEqual([]);
        expect(JSON.parse(calls[1])).toEqual(['tests/thing.test.ts', 'tests/other.test.ts']);
    });

    it('AC5: fails with "flaky: <names>" when the card already carries a test.flaky event naming one of the same tests', async () => {
        const worktree = await manager.create('0005', 'card/0005-thing');
        await mkdir(join(worktree.path, 'tests'), { recursive: true });
        await writeFile(join(worktree.path, 'tests', 'thing.test.ts'), "it('x', () => {});\n", 'utf8');

        await events.append({
            project: config.project,
            cardId: '0001',
            stage: 'testing',
            type: 'test.flaky',
            payload: { tests: ['tests/thing.test.ts > flaky test'] },
        });

        const scriptPath = await writeFakeSuite(worktree.path, {
            reportPath: 'report.json',
            tests: [{ file: 'tests/thing.test.ts', name: 'flaky test' }],
        });

        const stage = makeStage({ testCommand: `node ${scriptPath}`, testReportPath: 'report.json', baselineCheck: false });
        const outcome = await verifier.verify(verifyInput(worktree, stage));

        expect(outcome.passed).toBe(false);
        const recurrence = outcome.failures.find(f => f.startsWith('flaky:'));
        expect(recurrence).toBeDefined();
        expect(recurrence).toContain('tests/thing.test.ts > flaky test');
        // The pre-existing event from setup is the only one on record — recurrence does not append a
        // second.
        expect(events.append).toHaveBeenCalledTimes(1);
    });
});
