import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineProvesChange, checkCounts, scratchTestFileName, TestingVerifier } from '#modules/stages/testing.verifier.js';
import { parseTestReport } from '#modules/stages/test.report.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
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
