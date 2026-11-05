import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { WorktreeManager, type Worktree } from '#modules/worktree/worktree.manager.js';
import { MemoryHost } from '#tests/support/memory.host.js';

const exec = promisify(execFile);
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * Real git rather than a mock: what is being tested is how git reports each kind of change, and a
 * mock would only prove the test agrees with itself about that.
 */
describe('WorktreeManager.pathChanges', () => {
    let manager: WorktreeManager;
    let worktree: Worktree;
    const inTree = (path: string) => join(worktree.path, path);

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'path-changes-'));
        const codeRoot = join(base, 'code');
        await mkdir(join(codeRoot, 'tests'), { recursive: true });
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await writeFile(join(codeRoot, '.gitignore'), 'ignored/\n', 'utf8');
        await writeFile(join(codeRoot, 'tests', 'kept.test.ts'), 'original kept\n', 'utf8');
        await writeFile(join(codeRoot, 'tests', 'moved.test.ts'), 'a body long enough for rename detection to pair the two ends\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        manager = new WorktreeManager(new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run')), logger as never);
        worktree = await manager.create('0001', 'card/0001-thing');
    });

    it('reports nothing for an untouched tree', async () => {
        expect(await manager.pathChanges(worktree)).toEqual([]);
    });

    it('reports an uncommitted edit, a deletion and an untracked file', async () => {
        await writeFile(inTree('tests/kept.test.ts'), 'edited\n', 'utf8');
        await rm(inTree('tests/moved.test.ts'));
        await writeFile(inTree('tests/new.test.ts'), 'new\n', 'utf8');

        expect(await manager.pathChanges(worktree)).toEqual([
            { path: 'tests/kept.test.ts', status: 'modified' },
            { path: 'tests/moved.test.ts', status: 'deleted' },
            { path: 'tests/new.test.ts', status: 'added' },
        ]);
    });

    it('sees work a stage already committed', async () => {
        await writeFile(inTree('tests/kept.test.ts'), 'edited\n', 'utf8');
        await manager.commit(worktree, 'earlier stage');

        expect(await manager.pathChanges(worktree)).toEqual([{ path: 'tests/kept.test.ts', status: 'modified' }]);
    });

    it('reports a staged rename as a deletion and an addition, whatever rename detection would do', async () => {
        await rename(inTree('tests/moved.test.ts'), inTree('tests/renamed.test.ts'));
        await exec('git', ['add', '-A'], { cwd: worktree.path });

        // The contrast that makes this helper necessary: the existing list pairs the two ends.
        const { stdout } = await exec('git', ['diff', '-M', '--name-status', worktree.baseSha, '--'], { cwd: worktree.path });
        expect(stdout).toMatch(/^R/);

        expect(await manager.pathChanges(worktree)).toEqual([
            { path: 'tests/moved.test.ts', status: 'deleted' },
            { path: 'tests/renamed.test.ts', status: 'added' },
        ]);
    });

    it('treats a file untracked with git rm --cached as still there', async () => {
        await exec('git', ['rm', '-q', '--cached', 'tests/kept.test.ts'], { cwd: worktree.path });

        expect(await manager.pathChanges(worktree)).toEqual([{ path: 'tests/kept.test.ts', status: 'modified' }]);
    });

    it('leaves out ignored files', async () => {
        await mkdir(inTree('ignored'));
        await writeFile(inTree('ignored/a.test.ts'), 'x\n', 'utf8');

        expect(await manager.pathChanges(worktree)).toEqual([]);
    });

    it('returns a non-ASCII or spaced path unquoted, so it can be opened', async () => {
        await writeFile(inTree('tests/naïve name.test.ts'), 'new\n', 'utf8');

        const [change] = await manager.pathChanges(worktree);
        expect(change).toEqual({ path: 'tests/naïve name.test.ts', status: 'added' });
        expect(await manager.readCurrent(worktree, change!.path)).toBe('new\n');
    });

    it('reads both sides of an edited file', async () => {
        await writeFile(inTree('tests/kept.test.ts'), 'edited\n', 'utf8');

        expect(await manager.readAtBase(worktree, 'tests/kept.test.ts')).toBe('original kept\n');
        expect(await manager.readCurrent(worktree, 'tests/kept.test.ts')).toBe('edited\n');
    });

    it('throws when a side does not exist', async () => {
        await writeFile(inTree('tests/new.test.ts'), 'new\n', 'utf8');
        await rm(inTree('tests/kept.test.ts'));

        await expect(manager.readAtBase(worktree, 'tests/new.test.ts')).rejects.toThrow();
        await expect(manager.readCurrent(worktree, 'tests/kept.test.ts')).rejects.toThrow();
    });
});

/** No directory exists on this machine for this worktree, so reaching for local git or fs would fail. */
describe('path changes on a remote host', () => {
    const manager = new WorktreeManager(new StaticBoardConfig('p', '/nowhere/code', '/nowhere/worktrees', '/nowhere/run'), logger as never);

    it('lists and reads through the worktree’s host', async () => {
        const host = new MemoryHost((_, args) => {
            if (args[0] === 'diff') return { stdout: 'M\0tests/a.test.ts\0D\0tests/b.test.ts\0', stderr: '' };
            if (args[0] === 'ls-files') return { stdout: 'tests/c.test.ts\0', stderr: '' };
            if (args[0] === 'show') return { stdout: 'at base\n', stderr: '' };
            return { stdout: '', stderr: '' };
        });
        host.files.set('/remote/wt/0001/tests/a.test.ts', 'current\n');
        const worktree: Worktree = { path: '/remote/wt/0001', branch: 'card/0001', baseSha: 'abc', host };

        expect(await manager.pathChanges(worktree)).toEqual([
            { path: 'tests/a.test.ts', status: 'modified' },
            { path: 'tests/b.test.ts', status: 'deleted' },
            { path: 'tests/c.test.ts', status: 'added' },
        ]);
        expect(await manager.readAtBase(worktree, 'tests/a.test.ts')).toBe('at base\n');
        expect(await manager.readCurrent(worktree, 'tests/a.test.ts')).toBe('current\n');

        expect(host.commands.map(c => c.args)).toEqual([
            ['diff', '--no-renames', '--name-status', '-z', 'abc', '--'],
            ['ls-files', '--others', '--exclude-standard', '-z'],
            ['show', 'abc:tests/a.test.ts'],
        ]);
        expect(host.commands.every(c => c.options.cwd === '/remote/wt/0001')).toBe(true);
    });
});
