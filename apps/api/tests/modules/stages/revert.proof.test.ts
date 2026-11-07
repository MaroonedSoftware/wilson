import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { computeReviewEvidence, revertWrites } from '#modules/stages/review.evidence.js';
import { computeRevertProof, isRevertProofExempt, MAX_REVERT_PROOF_FILES } from '#modules/stages/revert.proof.js';
import { StageConfigSchema } from '#modules/stages/stage.config.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** The "suite": passes only while `src/a.ts` holds the card's change, and leaves a stray file behind. */
const CHECK = '#!/bin/sh\necho ran > stray.txt\ngrep -q two src/a.ts\n';

const setUp = async (headFiles: Record<string, string>, check = CHECK) => {
    const base = await mkdtemp(join(tmpdir(), 'revert-proof-'));
    const codeRoot = join(base, 'code');
    await mkdir(join(codeRoot, 'src'), { recursive: true });
    const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd });
    await git(codeRoot, 'init', '-q', '-b', 'main');
    await git(codeRoot, 'config', 'user.email', 't@example.com');
    await git(codeRoot, 'config', 'user.name', 't');
    await writeFile(join(codeRoot, 'check.sh'), check);
    await chmod(join(codeRoot, 'check.sh'), 0o755);
    await writeFile(join(codeRoot, 'src', 'a.ts'), 'one\n');
    await writeFile(join(codeRoot, 'src', 'b.ts'), 'x\n');
    await git(codeRoot, 'add', '-A');
    await git(codeRoot, 'commit', '-q', '-m', 'base');

    const config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
    const manager = new WorktreeManager(config, silentLogger as never);
    const worktree = await manager.create('0001', 'card/0001');
    for (const [path, text] of Object.entries(headFiles)) {
        await mkdir(join(worktree.path, path, '..'), { recursive: true });
        await writeFile(join(worktree.path, path), text);
    }
    await git(worktree.path, 'add', '-A');
    await git(worktree.path, 'commit', '-q', '-m', 'head');
    return { manager, worktree, config };
};

const CHANGE = { 'src/a.ts': 'two\n', 'src/b.ts': 'y\n', 'src/c.ts': 'new\n', 'tests/a.test.ts': 'test\n', 'README.md': 'docs\n' };

describe('isRevertProofExempt', () => {
    it.each(['tests/a.test.ts', 'src/a.spec.tsx', 'apps/api/tests/x.ts', 'README.md', 'pnpm-lock.yaml'])('leaves %s alone', path => {
        expect(isRevertProofExempt(path)).toBe(true);
    });

    it('tries source files', () => {
        expect(isRevertProofExempt('src/modules/stages/a.ts')).toBe(false);
    });
});

describe('computeRevertProof', () => {
    it('names the changed files whose old version still passes, and leaves the tree as it found it', async () => {
        const { manager, worktree } = await setUp(CHANGE);

        const proof = await computeRevertProof({ worktrees: manager }, worktree, './check.sh', () => 60_000, revertWrites);

        expect(proof).toEqual({ status: 'computed', command: './check.sh', unnoticed: ['src/b.ts', 'src/c.ts'], noticed: ['src/a.ts'], skipped: [] });
        expect(await manager.uncommittedPaths(worktree)).toEqual([]);
    });

    it('gives up when the check already fails on the branch, since then every file would look noticed', async () => {
        const { manager, worktree } = await setUp({ 'src/b.ts': 'y\n' });

        const proof = await computeRevertProof({ worktrees: manager }, worktree, './check.sh', () => 60_000, revertWrites);

        expect(proof).toMatchObject({ status: 'failed', reason: expect.stringContaining('already fails on the branch') });
    });

    it('lists files past the cap as not tried', async () => {
        const many = Object.fromEntries(Array.from({ length: MAX_REVERT_PROOF_FILES + 2 }, (_, index) => [`src/n${index}.ts`, 'n\n']));
        const { manager, worktree } = await setUp({ 'src/a.ts': 'two\n', ...many });

        const proof = await computeRevertProof({ worktrees: manager }, worktree, './check.sh', () => 60_000, revertWrites);

        expect(proof.status === 'computed' && proof.skipped).toHaveLength(MAX_REVERT_PROOF_FILES + 3 - MAX_REVERT_PROOF_FILES);
    });
});

describe('computeReviewEvidence revert proof', () => {
    it('adds a section naming the unnoticed files when the lane has a revertProofCommand', async () => {
        const { manager, worktree, config } = await setUp(CHANGE);
        const stage = StageConfigSchema.parse({
            name: 'review',
            mode: 'agent',
            model: 'm',
            instructions: 'i',
            onPass: 'ready',
            onFail: 'implementing',
            revertProofCommand: './check.sh',
        });

        const evidence = await computeReviewEvidence(
            { worktrees: manager, logger: silentLogger as never, runRoot: config.runRoot },
            { cardId: '0001', worktree, stage },
        );

        expect(evidence.markdown).toContain('### Files no check notices');
        expect(evidence.markdown).toContain('src/b.ts');
        expect(evidence.markdown).not.toContain('tests/a.test.ts');
        expect(evidence.summary).toMatchObject({ revertProofUnnoticed: 2, revertProofTried: 3 });
    });
});
