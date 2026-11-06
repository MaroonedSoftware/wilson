import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failingKeys, failingTestKey, partitionPreExisting, TestingVerifier } from '#modules/stages/testing.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { TestReport } from '#modules/stages/test.report.js';
import { planlessCard, stageDefaults } from '#tests/modules/stages/stage.fixture.js';
import type { ScopeGuard } from '#modules/agent/scope.guard.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const makeStage = (overrides: Partial<StageConfig> = {}): StageConfig => ({
    ...stageDefaults,
    name: 'testing',
    mode: 'agent',
    worktree: 'rw',
    provider: 'anthropic',
    model: 'claude-opus',
    instructions: 'test the thing',
    allowedCommands: [],
    worktreeFrom: 'branch',
    extraScope: [],
    baselineCheck: true,
    assertionCheck: false,
    maxSteps: 60,
    maxOutputTokens: 16000,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
    ...overrides,
});

describe('failingTestKey', () => {
    it('names a test by file and name, leaving out its message', () => {
        expect(failingTestKey({ file: 'a.test.ts', name: 'works', message: 'expected 1 to be 2' })).toBe('a.test.ts > works');
    });

    it('names a file that failed to load by file alone, since its message can carry the worktree path', () => {
        expect(failingTestKey({ file: 'a.test.ts', name: undefined, message: 'Cannot find /tmp/wt/0001/x' })).toBe('a.test.ts failed to load');
    });
});

describe('partitionPreExisting', () => {
    it('splits failures the baseline shares from ones it does not', () => {
        const baseline = { failing: [{ file: 'env.test.ts', name: 'needs a database' }] } as TestReport;
        const { preExisting, introduced } = partitionPreExisting(
            [
                { file: 'env.test.ts', name: 'needs a database', message: 'ECONNREFUSED' },
                { file: 'thing.test.ts', name: 'broken' },
            ],
            failingKeys(baseline),
        );
        expect(preExisting.map(failingTestKey)).toEqual(['env.test.ts > needs a database']);
        expect(introduced.map(failingTestKey)).toEqual(['thing.test.ts > broken']);
    });

    it('treats every failure as introduced when there is no baseline report', () => {
        const { preExisting, introduced } = partitionPreExisting([{ file: 'a.test.ts', name: 'x' }], failingKeys(undefined));
        expect(preExisting).toEqual([]);
        expect(introduced).toHaveLength(1);
    });
});

/**
 * The suite below is committed at the base, so the baseline worktree runs it too. A full run (no
 * file arguments) reports whatever `failing.json` in its tree lists, as ten tests; a run with file
 * arguments (the flaky rerun, and the baseline check's run of the copied tests) always exits 1.
 */
const FAKE_SUITE = [
    "const fs = require('fs');",
    "const path = require('path');",
    'if (process.argv.length > 2) process.exit(1);',
    "const failing = JSON.parse(fs.readFileSync('failing.json', 'utf8'));",
    'const report = {',
    '  numTotalTests: 10, numPassedTests: 10 - failing.length, numFailedTests: failing.length, numPendingTests: 0, numTodoTests: 0,',
    "  testResults: failing.map(t => ({ name: path.join(process.cwd(), t.file), status: 'failed', assertionResults: [{ status: 'failed', fullName: t.name }] })),",
    '};',
    "fs.writeFileSync('report.json', JSON.stringify(report));",
    'process.exit(failing.length > 0 ? 1 : 0);',
].join('\n');

const ENV_TEST = { file: 'tests/env.test.ts', name: 'needs a database' };
const NEW_TEST = { file: 'tests/thing.test.ts', name: 'thing works' };

describe('TestingVerifier — failures the baseline shares', () => {
    let base: string;
    let manager: WorktreeManager;
    let events: { append: ReturnType<typeof vi.fn>; tail: ReturnType<typeof vi.fn> };
    let verifier: TestingVerifier;

    beforeEach(async () => {
        // realpath: the fake suite names files from `process.cwd()`, which macOS resolves past /var.
        base = await realpath(await mkdtemp(join(tmpdir(), 'testing-verifier-preexisting-')));
        const codeRoot = join(base, 'code');
        await mkdir(codeRoot, { recursive: true });

        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await writeFile(join(codeRoot, 'fake-suite.cjs'), FAKE_SUITE, 'utf8');
        await writeFile(join(codeRoot, 'failing.json'), JSON.stringify([ENV_TEST]), 'utf8');
        await writeFile(join(codeRoot, '.gitignore'), 'report.json\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
        manager = new WorktreeManager(config, silentLogger as never);
        events = { append: vi.fn(async () => {}), tail: vi.fn(async () => []) };
        verifier = new TestingVerifier(manager, silentLogger as never, events as unknown as EventLog, config);
    });

    afterEach(async () => {
        await rm(base, { recursive: true, force: true }).catch(() => undefined);
    });

    /** A card worktree that adds a test file and whose suite reports `failing`. */
    const cardWith = async (id: string, failing: Array<{ file: string; name: string }>) => {
        const worktree = await manager.create(id, `card/${id}-thing`);
        await mkdir(join(worktree.path, 'tests'), { recursive: true });
        await writeFile(join(worktree.path, NEW_TEST.file), "it('thing works', () => {});\n", 'utf8');
        await writeFile(join(worktree.path, 'failing.json'), JSON.stringify(failing), 'utf8');
        return worktree;
    };

    const verify = (worktree: Awaited<ReturnType<WorktreeManager['create']>>, stage = makeStage()) =>
        verifier.verify({
            worktree,
            stage: { ...stage, testCommand: 'node fake-suite.cjs', testReportPath: 'report.json' },
            cardId: '0001',
            card: planlessCard(),
            scope: {} as ScopeGuard,
            result: undefined,
        });

    it('passes a run whose only failure also fails on the baseline, recording it as pre-existing', async () => {
        const outcome = await verify(await cardWith('0001', [ENV_TEST]));

        expect(outcome.failures).toEqual([]);
        expect(outcome.passed).toBe(true);
        expect(outcome.preExistingFailures).toEqual(['tests/env.test.ts > needs a database']);
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'test.preexisting',
                payload: { tests: ['tests/env.test.ts > needs a database'], run: 'testing' },
            }),
        );
    });

    it('still fails a run with a failure the baseline does not share, naming only that one', async () => {
        const outcome = await verify(await cardWith('0002', [ENV_TEST, NEW_TEST]));

        expect(outcome.passed).toBe(false);
        const redSuite = outcome.failures.find(f => f.startsWith('the suite is not green:'));
        expect(redSuite).toContain('1 failing: tests/thing.test.ts > thing works');
        expect(redSuite).not.toContain('needs a database');
        expect(outcome.preExistingFailures).toEqual(['tests/env.test.ts > needs a database']);
    });

    it('judges the run red as before when the baseline check is off, since no baseline ran', async () => {
        const outcome = await verify(await cardWith('0003', [ENV_TEST]), makeStage({ baselineCheck: false }));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures[0]).toContain('tests/env.test.ts > needs a database');
        expect(outcome.preExistingFailures).toBeUndefined();
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'test.preexisting' }));
    });
});
