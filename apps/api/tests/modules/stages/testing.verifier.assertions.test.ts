import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ScopeGuard } from '#modules/agent/scope.guard.js';
import { withAttempt } from '#modules/board/append.attempts.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { AssertionDelta } from '#modules/stages/assertion.delta.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import { checkAssertionDelta, TestingVerifier } from '#modules/stages/testing.verifier.js';
import { WorktreeManager, type Worktree } from '#modules/worktree/worktree.manager.js';
import { planlessCard, stageDefaults } from '#tests/modules/stages/stage.fixture.js';
import { MemoryHost } from '#tests/support/memory.host.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const stage: StageConfig = {
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
    baselineCheck: false,
    maxSteps: 60,
    maxOutputTokens: 16000,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
};

const test = (...assertions: string[]): string => `it('works', () => {\n${assertions.map(a => `    ${a};\n`).join('')}});\n`;

const delta = (overrides: Partial<AssertionDelta> = {}): AssertionDelta => ({
    baseCount: 2,
    currentCount: 2,
    lost: [],
    newTautologies: [],
    ...overrides,
});
const lost = { path: 'a.test.ts', line: 7, text: 'expect(a).toBe(1)' };
const tautology = { path: 'b.test.ts', line: 3, text: 'expect(true).toBe(true)' };

describe('checkAssertionDelta', () => {
    it('passes a card that lost nothing and added no tautology', () => {
        expect(checkAssertionDelta(delta())).toEqual([]);
        expect(checkAssertionDelta(delta({ currentCount: 9 }))).toEqual([]);
    });

    it('passes a card that lost an assertion by rewriting it, with the count unchanged', () => {
        expect(checkAssertionDelta(delta({ lost: [lost] }))).toEqual([]);
    });

    it('names the file, line and assertion first, on a net drop', () => {
        const [failure, ...rest] = checkAssertionDelta(delta({ currentCount: 1, lost: [lost] }));
        expect(rest).toEqual([]);
        expect(failure?.split('\n')[0]).toBe('a.test.ts:7 lost expect(a).toBe(1): assertions fell from 2 to 1 across this card');
    });

    it('names the file, line and assertion first, on a tautology', () => {
        const [failure] = checkAssertionDelta(delta({ newTautologies: [tautology, tautology, tautology] }));
        expect(failure?.split('\n')[0]).toBe('b.test.ts:3 adds expect(true).toBe(true), which cannot fail and 2 more');
    });

    it('lets a declaration cover a drop, a tautology or the two together, up to its ceiling', () => {
        expect(checkAssertionDelta(delta({ currentCount: 1, lost: [lost] }), 1)).toEqual([]);
        expect(checkAssertionDelta(delta({ newTautologies: [tautology] }), 1)).toEqual([]);
        expect(checkAssertionDelta(delta({ currentCount: 1, lost: [lost], newTautologies: [tautology] }), 2)).toEqual([]);
    });

    it('says so when a card goes past what it declared', () => {
        const failures = checkAssertionDelta(delta({ currentCount: 1, lost: [lost], newTautologies: [tautology] }), 1);
        expect(failures).toHaveLength(2);
        for (const failure of failures) expect(failure.split('\n')[0]).toContain('more than the 1 this plan declares');
    });

    it('keeps a very long assertion from pushing the rest of the line out', () => {
        const text = `expect(a).toEqual(${'x'.repeat(500)})`;
        const [failure] = checkAssertionDelta(delta({ currentCount: 1, lost: [{ ...lost, text }] }));
        expect(failure?.split('\n')[0]?.length).toBeLessThan(200);
    });
});

/**
 * Against real git worktrees, since what matters is which side of a file the check reads when work
 * is uncommitted. `baselineCheck` is off in every test here, because this check must not depend on it.
 */
describe('TestingVerifier: weakened tests', () => {
    let manager: WorktreeManager;
    let verifier: TestingVerifier;
    let worktree: Worktree;

    const write = async (path: string, content: string) => {
        await mkdir(dirname(join(worktree.path, path)), { recursive: true });
        await writeFile(join(worktree.path, path), content, 'utf8');
    };
    const verify = async (card: Card = planlessCard(), overrides: Partial<StageConfig> = {}, tree = worktree) => {
        const outcome = await verifier.verify({
            worktree: tree,
            stage: { ...stage, ...overrides },
            cardId: '0001',
            card,
            scope: {} as ScopeGuard,
            result: undefined,
        });
        return outcome.failures.filter(failure => /lost |adds |assertion check/.test(failure));
    };
    const declaring = (bullet: string): Card => ({ ...planlessCard(), sections: { Constraints: bullet } });

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'testing-assertions-'));
        const codeRoot = join(base, 'code');
        await mkdir(join(codeRoot, 'tests'), { recursive: true });
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await writeFile(join(codeRoot, 'tests', 'a.test.ts'), test('expect(total(1, 2)).toBe(3)', 'expect(total(2, 2)).toBe(4)'), 'utf8');
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
        manager = new WorktreeManager(config, silentLogger as never);
        verifier = new TestingVerifier(manager, silentLogger as never, {} as EventLog, config);
        worktree = await manager.create('0001', 'card/0001-thing');
    });

    it('fails an assertion replaced by expect(true).toBe(true), then passes once the plan declares it', async () => {
        await write('tests/a.test.ts', test('expect(true).toBe(true)', 'expect(total(2, 2)).toBe(4)'));

        expect(await verify()).toEqual([expect.stringContaining('tests/a.test.ts:2 adds expect(true).toBe(true), which cannot fail')]);
        expect(await verify(declaring('- Expected assertion drop: 1 (the total helper is going away)'))).toEqual([]);
    });

    it('fails an assertion commented out', async () => {
        await write('tests/a.test.ts', test('// expect(total(1, 2)).toBe(3)', 'expect(total(2, 2)).toBe(4)'));

        expect(await verify()).toEqual([expect.stringContaining('tests/a.test.ts:2 lost expect(total(1, 2)).toBe(3): assertions fell from 2 to 1')]);
    });

    it('fails a deleted test file', async () => {
        await rm(join(worktree.path, 'tests/a.test.ts'));

        expect(await verify()).toEqual([expect.stringContaining('tests/a.test.ts:2 lost')]);
    });

    it('fails a test file renamed and gutted, committed or not', async () => {
        const gutted = test('expect(total(1, 2)).toBe(3)');
        await rename(join(worktree.path, 'tests/a.test.ts'), join(worktree.path, 'tests/b.test.ts'));
        await write('tests/b.test.ts', gutted);
        await exec('git', ['add', '-A'], { cwd: worktree.path });
        expect(await verify()).toEqual([expect.stringContaining('tests/a.test.ts:3 lost expect(total(2, 2)).toBe(4)')]);

        await manager.commit(worktree, 'earlier stage');
        expect(await verify()).toEqual([expect.stringContaining('tests/a.test.ts:3 lost expect(total(2, 2)).toBe(4)')]);
    });

    it('passes a test file renamed whole, and tests moved between files', async () => {
        await rm(join(worktree.path, 'tests/a.test.ts'));
        await write('tests/c.test.ts', test('expect(total(1, 2)).toBe(3)'));
        await write('tests/d.test.ts', test('expect(total(2, 2)).toBe(4)'));

        expect(await verify()).toEqual([]);
    });

    it('passes a drop that new assertions elsewhere more than make up', async () => {
        await write('tests/a.test.ts', test('expect(total(1, 2)).toBe(3)'));
        await write('tests/new.test.ts', test('expect(other(1)).toBe(1)', 'expect(other(2)).toBe(2)'));

        expect(await verify()).toEqual([]);
    });

    it('fails a drop past what the plan declares', async () => {
        await rm(join(worktree.path, 'tests/a.test.ts'));

        expect(await verify(declaring('- Expected assertion drop: 1 (one is going)'))).toEqual([
            expect.stringContaining('assertions fell from 2 to 0 across this card, more than the 1 this plan declares'),
        ]);
    });

    it('does not take a declaration with no reason', async () => {
        await rm(join(worktree.path, 'tests/a.test.ts'));

        expect(await verify(declaring('- Expected assertion drop: 2'))).toHaveLength(1);
    });

    it('does not take a stage’s caveats as a reason', async () => {
        await rm(join(worktree.path, 'tests/a.test.ts'));
        const outcome = await verifier.verify({
            worktree,
            stage,
            cardId: '0001',
            card: planlessCard(),
            scope: {} as ScopeGuard,
            result: { caveats: ['Expected assertion drop: 2 (I removed them on purpose)'] } as never,
        });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.join('\n')).toContain('tests/a.test.ts:2 lost');
    });

    it('does not read a test in another language', async () => {
        await write('tests/CardTest.kt', 'expect(true).toBe(true)\n');

        expect(await verify()).toEqual([]);
    });

    it('ignores a tautology quoted in a fixture string', async () => {
        await write(
            'tests/a.test.ts',
            `${test('expect(total(1, 2)).toBe(3)', 'expect(total(2, 2)).toBe(4)')}const fixture = "expect(true).toBe(true)";\n`,
        );

        expect(await verify()).toEqual([]);
    });

    it('stays out of the way when the lane turns it off', async () => {
        await rm(join(worktree.path, 'tests/a.test.ts'));

        expect(await verify(planlessCard(), { assertionCheck: false })).toEqual([]);
    });

    it('fails rather than passes when it cannot read a side', async () => {
        const local = new MemoryHost((_, args) => {
            if (args[0] === 'diff' && args.includes('--no-renames')) return { stdout: 'D\0tests/a.test.ts\0', stderr: '' };
            if (args[0] === 'show') throw new Error('object not found');
            return { stdout: '', stderr: '' };
        });
        const failures = await verify(planlessCard(), {}, { path: '/remote/wt', branch: 'b', baseSha: 'abc', host: local });
        expect(failures).toEqual([expect.stringContaining('the assertion check could not read')]);
    });

    it('keeps the file and the assertion in what a retried stage is told', async () => {
        await write('tests/a.test.ts', test('expect(true).toBe(true)', 'expect(total(2, 2)).toBe(4)'));
        const failures = await verify();

        const body = withAttempt('## Goal\n\nDo it.', { stage: 'testing', attempt: 1, maxKickbacks: 3, date: '2026-11-04', failures });

        expect(body).toContain('tests/a.test.ts:2 adds expect(true).toBe(true), which cannot fail');
        expect(body).not.toContain("a stage's caveats");
    });

    it('reads both sides on the worktree’s own host', async () => {
        const host = new MemoryHost((_, args) => {
            if (args[0] === 'diff' && args.includes('--no-renames')) return { stdout: 'M\0tests/a.test.ts\0', stderr: '' };
            if (args[0] === 'show') return { stdout: test('expect(total(1, 2)).toBe(3)'), stderr: '' };
            return { stdout: '', stderr: '' };
        });
        host.files.set('/remote/wt/tests/a.test.ts', test('expect(true).toBe(true)'));

        expect(await verify(planlessCard(), {}, { path: '/remote/wt', branch: 'b', baseSha: 'abc', host })).toEqual([
            expect.stringContaining('tests/a.test.ts:2 adds expect(true).toBe(true)'),
        ]);
    });
});
