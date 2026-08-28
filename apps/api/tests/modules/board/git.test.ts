import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { conflictingPaths, mergeTree } from '#modules/board/git.js';

const exec = promisify(execFile);

/**
 * Card 0143: `mergeTree` and `conflictingPaths` are the pieces that let a merge be computed without
 * a checkout — `git merge-tree --write-tree` writes the merged tree straight into the object
 * database, and reports a conflict on stdout rather than by throwing. Exercised against a real repo
 * because the whole point of these two functions is a real git binary's actual exit code and stdout
 * shape on both outcomes; a mock of `execFile` would only prove this file agrees with itself about
 * what git does.
 */
describe('mergeTree', () => {
    let repo: string;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'git-mergetree-'));
        repo = join(base, 'repo');
        await mkdir(repo, { recursive: true });
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: repo });
        await writeFile(join(repo, 'a.txt'), 'line one\n', 'utf8');
        await writeFile(join(repo, 'b.txt'), 'unrelated\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: repo });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });
    });

    it('computes the merged tree for two non-conflicting branches, without touching the working tree', async () => {
        const main = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

        await exec('git', ['checkout', '-q', '-b', 'feature'], { cwd: repo });
        await writeFile(join(repo, 'c.txt'), 'from feature\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: repo });
        await exec('git', ['commit', '-q', '-m', 'feature commit'], { cwd: repo });
        const feature = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
        await exec('git', ['checkout', '-q', 'main'], { cwd: repo });

        const result = await mergeTree(repo, main, feature);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected a clean merge');
        // The written tree really does contain the union of both branches' content — read straight
        // from the object database, since nothing was checked out.
        const aFromTree = await exec('git', ['show', `${result.treeSha}:a.txt`], { cwd: repo });
        const cFromTree = await exec('git', ['show', `${result.treeSha}:c.txt`], { cwd: repo });
        expect(aFromTree.stdout).toBe('line one\n');
        expect(cFromTree.stdout).toBe('from feature\n');

        // `cwd`'s own working tree and HEAD never moved.
        const branch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).stdout.trim();
        expect(branch).toBe('main');
        const status = (await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout;
        expect(status.trim()).toBe('');
    });

    it('reports conflicting paths on stdout instead of throwing', async () => {
        await exec('git', ['checkout', '-q', '-b', 'feature'], { cwd: repo });
        await writeFile(join(repo, 'a.txt'), 'line one, changed on feature\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: repo });
        await exec('git', ['commit', '-q', '-m', 'feature edits a.txt'], { cwd: repo });
        const feature = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
        await exec('git', ['checkout', '-q', 'main'], { cwd: repo });

        // main edits the same line differently, so the two histories genuinely conflict.
        await writeFile(join(repo, 'a.txt'), 'line one, changed on main\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: repo });
        await exec('git', ['commit', '-q', '-m', 'main edits a.txt too'], { cwd: repo });
        const mainAfter = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

        const result = await mergeTree(repo, mainAfter, feature);

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected a conflict');
        expect(result.output).toContain('a.txt');
        expect(conflictingPaths(result.output)).toEqual(['a.txt']);

        // Still no working-tree mutation — this is exactly what makes the no-checkout approach safe.
        const status = (await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout;
        expect(status.trim()).toBe('');
    });

    // `merge-tree` itself erroring before it could attempt a merge — as opposed to attempting one
    // and reporting a conflict — exits with something other than 1 (git uses 128 for "this isn't
    // even a repository"), which is exactly the case `mergeTree`'s `e.code === 1` check is there to
    // tell apart from a genuine conflict.
    it('throws when merge-tree fails outright, rather than treating every non-zero exit as a conflict', async () => {
        const notARepo = await mkdtemp(join(tmpdir(), 'git-mergetree-notrepo-'));

        await expect(mergeTree(notARepo, 'HEAD', 'HEAD')).rejects.toThrow(/merge-tree/);
    });
});

describe('conflictingPaths', () => {
    // A hand-built sample of `merge-tree --write-tree`'s real shape: structured `ls-files --stage`
    // lines the function must parse, interleaved with the free-text conflict messages it must ignore.
    const SAMPLE_OUTPUT = [
        '100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1\tsrc/shared.ts',
        '100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2\tsrc/shared.ts',
        '100644 cccccccccccccccccccccccccccccccccccccccc 3\tsrc/shared.ts',
        'CONFLICT (content): Merge conflict in src/shared.ts',
        '100644 dddddddddddddddddddddddddddddddddddddddd 2\tsrc/only-ours.ts',
        '100644 eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee 3\tsrc/only-theirs.ts',
        'Auto-merging src/shared.ts',
    ].join('\n');

    it('extracts every distinct conflicted path from the structured lines, sorted', () => {
        expect(conflictingPaths(SAMPLE_OUTPUT)).toEqual(['src/only-ours.ts', 'src/only-theirs.ts', 'src/shared.ts']);
    });

    it('never lets a free-text message line be mistaken for a path', () => {
        const paths = conflictingPaths(SAMPLE_OUTPUT);
        for (const path of paths) {
            expect(path).not.toContain('CONFLICT');
            expect(path).not.toContain('Auto-merging');
        }
    });

    it('returns nothing for output with no structured conflict lines', () => {
        expect(conflictingPaths('CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed.\n')).toEqual([]);
    });
});
