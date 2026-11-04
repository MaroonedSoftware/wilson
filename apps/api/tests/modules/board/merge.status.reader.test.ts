import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@maroonedsoftware/logger';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { MergeStatusReader } from '#modules/board/merge.status.reader.js';
import { RE_REVIEW_CAP } from '#modules/board/re.review.js';
import { DRY_RUN_ENABLED } from '#modules/settings/dry.run.setting.js';
import { RE_REVIEW_ON_MERGE } from '#modules/settings/re.review.on.merge.setting.js';
import type { SettingDefinition } from '#modules/settings/setting.definition.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import { DRY_RUN_INTEGRATION_BRANCH, WorktreeManager } from '#modules/worktree/worktree.manager.js';

const exec = promisify(execFile);

/** Against a real repo, since the answer is whatever a real git binary says about real commits. */
describe('MergeStatusReader', () => {
    let repo: string;
    let worktrees: WorktreeManager;
    let settings: { dryRun: boolean; reReview: boolean };
    let reader: MergeStatusReader;

    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: repo })).stdout.trim();

    const commit = async (file: string, content: string): Promise<void> => {
        await writeFile(join(repo, file), content, 'utf8');
        await git('add', '-A');
        await git('commit', '-q', '-m', `write ${file}`);
    };

    /** Everything a read could move: every ref, the checkout, the index and the working tree. */
    const snapshot = async (): Promise<string[]> => [
        await git('for-each-ref'),
        await git('rev-parse', 'HEAD'),
        await git('symbolic-ref', 'HEAD'),
        await git('status', '--porcelain'),
        await git('ls-files', '--stage'),
        await readFile(join(repo, 'a.txt'), 'utf8'),
    ];

    /** `card` forks from `main`, then each side writes what it is given and `main` is checked out again. */
    const fork = async (changes: { card?: [string, string]; main?: [string, string] }): Promise<void> => {
        await git('checkout', '-q', '-b', 'card');
        if (changes.card) await commit(...changes.card);
        await git('checkout', '-q', 'main');
        if (changes.main) await commit(...changes.main);
    };

    beforeEach(async () => {
        repo = await mkdtemp(join(tmpdir(), 'merge-status-'));
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        await git('config', 'user.email', 'test@example.com');
        await git('config', 'user.name', 'Test');
        await writeFile(join(repo, 'b.txt'), 'unrelated\n', 'utf8');
        await commit('a.txt', 'line one\n');

        settings = { dryRun: false, reReview: false };
        const config = new StaticBoardConfig('proj', repo, join(repo, '..', 'wt'), join(repo, '..', 'run'));
        worktrees = new WorktreeManager(config, { info: () => undefined } as unknown as Logger);
        const store = {
            get: async (setting: SettingDefinition<boolean>) => {
                if (setting === DRY_RUN_ENABLED) return settings.dryRun;
                if (setting === RE_REVIEW_ON_MERGE) return settings.reReview;
                throw new Error(`unexpected setting ${setting.key}`);
            },
        } as unknown as SettingsStore;
        reader = new MergeStatusReader(worktrees, store);
    });

    it('reports clean when the two sides touched different files', async () => {
        await fork({ card: ['c.txt', 'card\n'], main: ['b.txt', 'moved\n'] });

        expect(await reader.read('card')).toEqual({ state: 'clean', target: 'main', conflicts: [], movedUnder: [] });
    });

    it('reports a real conflict with main, naming the path', async () => {
        await fork({ card: ['a.txt', 'card\n'], main: ['a.txt', 'main\n'] });

        expect(await reader.read('card')).toEqual({ state: 'conflict', target: 'main', conflicts: ['a.txt'], movedUnder: ['a.txt'] });
    });

    it('moves no ref, file or index entry, on a clean merge or a conflicting one', async () => {
        await fork({ card: ['a.txt', 'card\n'], main: ['a.txt', 'main\n'] });
        await git('checkout', '-q', '-b', 'clean-card', 'main~1');
        await commit('c.txt', 'card\n');
        await git('checkout', '-q', 'main');
        settings.dryRun = true;

        const before = await snapshot();
        await reader.read('card');
        await reader.read('clean-card');
        await reader.read('no-such-branch');

        expect(await snapshot()).toEqual(before);
        expect(await git('branch', '--list', DRY_RUN_INTEGRATION_BRANCH)).toBe('');
    });

    describe('re-review', () => {
        it('wins over a conflict, as BoardWriteService.merge checks it first, and still lists the conflict', async () => {
            settings.reReview = true;
            await fork({ card: ['a.txt', 'card\n'], main: ['a.txt', 'main\n'] });

            expect(await reader.read('card')).toEqual({ state: 'rereview', target: 'main', conflicts: ['a.txt'], movedUnder: ['a.txt'] });
        });

        it('reports a merge that resolves cleanly but changes a file both sides touched', async () => {
            settings.reReview = true;
            await commit('a.txt', '1\n2\n3\n4\n5\n6\n7\n8\n9\n');
            await fork({ card: ['a.txt', 'card\n2\n3\n4\n5\n6\n7\n8\n9\n'], main: ['a.txt', '1\n2\n3\n4\n5\n6\n7\n8\nmain\n'] });

            expect(await reader.read('card')).toEqual({ state: 'rereview', target: 'main', conflicts: [], movedUnder: ['a.txt'] });
        });

        it('stays clean when main moved only under other files', async () => {
            settings.reReview = true;
            await fork({ card: ['c.txt', 'card\n'], main: ['b.txt', 'moved\n'] });

            expect((await reader.read('card')).state).toBe('clean');
        });

        it('reports capped once the card has used up its re-reviews, when Merge flags rather than sends back', async () => {
            settings.reReview = true;
            await fork({ card: ['a.txt', 'card\n'], main: ['a.txt', 'main\n'] });

            expect((await reader.read('card', RE_REVIEW_CAP - 1)).state).toBe('rereview');
            expect(await reader.read('card', RE_REVIEW_CAP)).toEqual({
                state: 'capped',
                target: 'main',
                conflicts: ['a.txt'],
                movedUnder: ['a.txt'],
            });
        });

        it('takes effect at once when the setting flips, without recomputing git', async () => {
            await fork({ card: ['a.txt', 'card\n'], main: ['a.txt', 'main\n'] });
            const computeMerge = vi.spyOn(worktrees, 'computeMerge');

            expect((await reader.read('card')).state).toBe('conflict');
            settings.reReview = true;
            expect((await reader.read('card')).state).toBe('rereview');
            expect(computeMerge).toHaveBeenCalledTimes(1);
        });
    });

    describe('the target', () => {
        it('uses main under a dry run when the integration branch does not exist, and does not create it', async () => {
            settings.dryRun = true;
            await fork({ card: ['c.txt', 'card\n'] });

            expect(await reader.read('card')).toMatchObject({ state: 'clean', target: 'main' });
            expect(await git('branch', '--list', DRY_RUN_INTEGRATION_BRANCH)).toBe('');
        });

        it('uses the integration branch under a dry run when it exists', async () => {
            settings.dryRun = true;
            await fork({ card: ['a.txt', 'card\n'] });
            await git('checkout', '-q', '-b', DRY_RUN_INTEGRATION_BRANCH);
            await commit('a.txt', 'rehearsed\n');
            await git('checkout', '-q', 'main');

            expect(await reader.read('card')).toMatchObject({ state: 'conflict', target: DRY_RUN_INTEGRATION_BRANCH, conflicts: ['a.txt'] });
        });

        it('ignores the integration branch when dry run is off', async () => {
            await fork({ card: ['a.txt', 'card\n'] });
            await git('branch', DRY_RUN_INTEGRATION_BRANCH);
            await git('checkout', '-q', DRY_RUN_INTEGRATION_BRANCH);
            await commit('a.txt', 'rehearsed\n');
            await git('checkout', '-q', 'main');

            expect(await reader.read('card')).toMatchObject({ state: 'clean', target: 'main' });
        });
    });

    describe('the cache', () => {
        it('runs git once for the same pair of commits, even for reads that overlap', async () => {
            await fork({ card: ['c.txt', 'card\n'] });
            const computeMerge = vi.spyOn(worktrees, 'computeMerge');

            await Promise.all([reader.read('card'), reader.read('card')]);
            await reader.read('card');

            expect(computeMerge).toHaveBeenCalledTimes(1);
        });

        it('recomputes when main moves, which emits no event', async () => {
            await fork({ card: ['a.txt', 'card\n'] });
            expect((await reader.read('card')).state).toBe('clean');

            await commit('a.txt', 'main\n');

            expect(await reader.read('card')).toMatchObject({ state: 'conflict', conflicts: ['a.txt'] });
        });

        it('does not keep a failure', async () => {
            await fork({ card: ['c.txt', 'card\n'] });
            const computeMerge = vi.spyOn(worktrees, 'computeMerge').mockRejectedValueOnce(new Error('git fell over'));

            expect((await reader.read('card')).state).toBe('unknown');
            expect((await reader.read('card')).state).toBe('clean');
            expect(computeMerge).toHaveBeenCalledTimes(2);
        });
    });

    describe('a read that fails', () => {
        it('answers unknown for a branch missing from the repo', async () => {
            const status = await reader.read('no-such-branch');

            expect(status).toEqual({
                state: 'unknown',
                target: 'main',
                conflicts: [],
                movedUnder: [],
                reason: 'branch no-such-branch is not in the code repo',
            });
        });

        it('answers unknown without a target when the settings cannot be read', async () => {
            const broken = new MergeStatusReader(worktrees, {
                get: async () => {
                    throw new Error('database down');
                },
            } as unknown as SettingsStore);

            expect(await broken.read('card')).toEqual({ state: 'unknown', conflicts: [], movedUnder: [], reason: 'database down' });
        });
    });
});
