import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import { CardBranchDiffSource } from '#modules/review/review.diff.source.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const card = (branch: string): Card => ({ frontmatter: { id: '0001', title: 'A thing', branch } }) as unknown as Card;

/** Real git, because what this seam promises is which commit a read is bound to. */
describe('CardBranchDiffSource', () => {
    let codeRoot: string;
    let manager: WorktreeManager;
    let source: CardBranchDiffSource;

    const git = async (...args: string[]) => (await exec('git', args, { cwd: codeRoot })).stdout.trim();

    const commit = async (file: string, text: string) => {
        await writeFile(join(codeRoot, file), text, 'utf8');
        await git('add', '-A');
        await git('commit', '-q', '-m', `write ${file}`);
        return git('rev-parse', 'HEAD');
    };

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'review-diff-'));
        codeRoot = join(base, 'code');
        await mkdir(codeRoot, { recursive: true });
        await git('init', '-q', '-b', 'main');
        await git('config', 'user.email', 'test@example.com');
        await git('config', 'user.name', 'Test');
        await commit('a.ts', 'one\n');
        manager = new WorktreeManager(new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run')), silentLogger as never);
        source = new CardBranchDiffSource(manager);
    });

    it('reads what patchSinceFork reads, naming the commit it ended at', async () => {
        await git('checkout', '-q', '-b', 'card/0001');
        const head = await commit('a.ts', 'one\ntwo\n');

        const result = await source.read(card('card/0001'));
        const direct = await manager.patchSinceFork('card/0001', 'main');

        expect(direct.ok).toBe(true);
        if (!direct.ok) return;
        expect(result).toEqual({ ok: true, head, base: direct.base, files: direct.files, truncated: direct.truncated });
    });

    it('stays on the commit it is given when the branch moves on', async () => {
        await git('checkout', '-q', '-b', 'card/0001');
        const first = await commit('a.ts', 'one\ntwo\n');
        await commit('b.ts', 'later\n');

        const result = await source.read(card('card/0001'), first);

        expect(result).toMatchObject({ ok: true, head: first });
        expect(result.ok && result.files.map(file => file.path)).toEqual(['a.ts']);
    });

    it("carries patchSinceFork's refusal for a branch never cut, and reports no head for it", async () => {
        expect(await source.head(card('card/9999'))).toBeUndefined();
        expect(await source.read(card('card/9999'))).toEqual({ ok: false, reason: expect.stringContaining('card/9999') });
    });
});
