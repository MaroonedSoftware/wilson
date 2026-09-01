import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReviewVerifier } from '#modules/stages/review.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { ScopeGuard } from '#modules/agent/scope.guard.js';
import type { StageConfig } from '#modules/stages/stage.config.js';

const exec = promisify(execFile);

/**
 * Exercises `ReviewVerifier.verify` against a real git worktree, the same way
 * `testing.verifier.test.ts` exercises `TestingVerifier` — the checks under test are precisely what
 * git reports as changed versus merely present, so a mock would only prove the test agrees with
 * itself about that.
 *
 * Card 0101: a `defect` that cites a file outside the diff but present in the worktree is what card
 * 0079's reviewer produced for `release.command.ts` — an accurate finding, mislabelled. The verifier
 * must correct it rather than fail the stage over it, while a finding that cites a file nowhere in
 * the worktree — a genuine hallucination — must still fail exactly as before.
 */
describe('ReviewVerifier', () => {
    let codeRoot: string;
    let manager: WorktreeManager;
    let verifier: ReviewVerifier;
    let warnCalls: string[];
    const stage = {} as StageConfig;
    const verifyInput = (worktree: Awaited<ReturnType<WorktreeManager['create']>>, result: unknown) => ({
        worktree,
        stage,
        cardId: '0001',
        scope: {} as ScopeGuard,
        result,
    });

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'review-verifier-'));
        codeRoot = join(base, 'code');
        await mkdir(join(codeRoot, 'src'), { recursive: true });

        // A file present from the start of the branch. The card's diff never touches it, but it is
        // a real file in the worktree — the file card 0079's reviewer cited stands in for it.
        await writeFile(join(codeRoot, 'src', 'kept.ts'), 'export const kept = 1;\nexport const kept2 = 2;\n', 'utf8');

        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
        const silentLogger = { info: () => {}, warn: (msg: string) => warnCalls.push(msg), error: () => {}, debug: () => {} };
        warnCalls = [];
        manager = new WorktreeManager(config, silentLogger as never);
        verifier = new ReviewVerifier(manager, silentLogger as never);
    });

    /** Commits a change to `src/changed.ts` on the worktree's branch, standing in for the card's diff. */
    const makeDiff = async (worktree: Awaited<ReturnType<WorktreeManager['create']>>) => {
        await writeFile(join(worktree.path, 'src', 'changed.ts'), 'export const a = 1;\nexport const b = 2;\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: worktree.path });
        await exec('git', ['commit', '-q', '-m', 'card diff'], { cwd: worktree.path });
    };

    it('corrects a defect that cites a file outside the diff but present in the worktree, instead of failing the stage', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await makeDiff(worktree);

        const finding = { severity: 'blocker', kind: 'defect', file: 'src/kept.ts', line: 2, problem: 'stale comment', suggestion: 'update it' };
        const result = { summary: 'reviewed', verdict: 'revise', findings: [finding] };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.failures).toEqual([]);
        expect(outcome.passed).toBe(true);
        // The finding itself is untouched by the correction — file, severity and text all survive.
        expect(finding.file).toBe('src/kept.ts');
        expect(finding.severity).toBe('blocker');
        expect(finding.problem).toBe('stale comment');
        expect(finding.suggestion).toBe('update it');
    });

    it('logs the reclassification', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await makeDiff(worktree);

        const result = {
            summary: 'reviewed',
            verdict: 'revise',
            findings: [{ severity: 'blocker', kind: 'defect', file: 'src/kept.ts', line: 2, problem: 'p', suggestion: 's' }],
        };

        await verifier.verify(verifyInput(worktree, result));

        const hit = warnCalls.find(msg => msg.includes('src/kept.ts'));
        expect(hit).toBeDefined();
        expect(hit).toMatch(/"defect"/);
        expect(hit).toMatch(/"omission"/);
    });

    it('still fails a defect citing a file that exists in neither the diff nor the worktree', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await makeDiff(worktree);

        const result = {
            summary: 'reviewed',
            verdict: 'revise',
            findings: [{ severity: 'blocker', kind: 'defect', file: 'src/missing.ts', line: 1, problem: 'p', suggestion: 's' }],
        };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toHaveLength(1);
        expect(outcome.failures[0]).toContain('src/missing.ts');
        expect(outcome.failures[0]).toContain('not in this card\'s diff');
        expect(outcome.failures[0]).toContain('report it as kind "omission"');
        expect(warnCalls).toEqual([]);
    });

    it('still fails a defect citing a real file in the diff with an out-of-range line, unchanged', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await makeDiff(worktree);

        const result = {
            summary: 'reviewed',
            verdict: 'revise',
            findings: [{ severity: 'blocker', kind: 'defect', file: 'src/changed.ts', line: 50, problem: 'p', suggestion: 's' }],
        };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toHaveLength(1);
        expect(outcome.failures[0]).toContain('src/changed.ts:50');
        expect(outcome.failures[0]).toMatch(/has only 3 lines/);
        expect(warnCalls).toEqual([]);
    });
});
