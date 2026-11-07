import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { ScopeGuard } from '#modules/agent/scope.guard.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import { WalkVerifier, type WalkResult } from '#modules/stages/walk.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const card = { frontmatter: { id: '0001', title: 't', stage: 'review', dependsOn: [], retries: {} }, sections: {}, body: '' } as Card;

const setUp = async () => {
    const base = await mkdtemp(join(tmpdir(), 'walk-'));
    const codeRoot = join(base, 'code');
    await mkdir(join(codeRoot, 'src'), { recursive: true });
    const git = (...args: string[]) => exec('git', args, { cwd: codeRoot });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 't@example.com');
    await git('config', 'user.name', 't');
    await writeFile(join(codeRoot, 'src', 'page.tsx'), 'export {};\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'base');
    const manager = new WorktreeManager(new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run')), silentLogger as never);
    return { manager, worktree: await manager.create('0001', 'card/0001') };
};

const ok = { action: 'opened the card', expected: 'the question shows', observed: 'the question shows', ok: true };
const broken = { ...ok, observed: 'a blank page', ok: false };
const blocker = {
    severity: 'blocker' as const,
    kind: 'omission' as const,
    file: 'src/page.tsx',
    problem: 'the page is blank',
    suggestion: 'render the question',
};
const concern = { ...blocker, severity: 'concern' as const, problem: 'the walk could not open a browser' };

const walk = (fields: Partial<WalkResult>): WalkResult => ({
    summary: 's',
    path: 'open a card, answer it',
    steps: [ok],
    verdict: 'pass',
    findings: [],
    ...fields,
});

describe('WalkVerifier', () => {
    const verify = async (result: unknown, before?: (path: string) => Promise<void>) => {
        const { manager, worktree } = await setUp();
        await before?.(worktree.path);
        return new WalkVerifier(manager).verify({ worktree, card, cardId: '0001', stage: {} as StageConfig, scope: {} as ScopeGuard, result });
    };

    it.each([
        ['a clean pass', walk({})],
        ['a revise with a failed step and a blocker', walk({ verdict: 'revise', steps: [ok, broken], findings: [blocker] })],
        ['a not-tested that says why and leaves a finding', walk({ verdict: 'not-tested', notTested: 'no browser here', findings: [concern] })],
    ])('accepts %s', async (_label, result) => {
        expect((await verify(result)).failures).toEqual([]);
    });

    it.each([
        ['a pass over a failed step', walk({ steps: [broken] }), 'a step of the walk is not ok'],
        ['a pass carrying a blocker', walk({ findings: [blocker] }), 'a finding is a blocker'],
        ['a revise with every step ok', walk({ verdict: 'revise', findings: [blocker] }), 'every step of the walk is ok'],
        ['a revise with no blocker', walk({ verdict: 'revise', steps: [broken] }), 'no finding is a blocker'],
        ['a not-tested with no reason', walk({ verdict: 'not-tested', findings: [concern] }), 'does not say what nobody ran'],
        ['a not-tested with no finding', walk({ verdict: 'not-tested', notTested: 'no browser' }), 'no finding tells the person'],
        [
            'a finding citing a file that is not there',
            walk({ verdict: 'revise', steps: [broken], findings: [{ ...blocker, file: 'src/nope.tsx' }] }),
            'does not exist',
        ],
    ])('rejects %s as a fault in the report', async (_label, result, message) => {
        const outcome = await verify(result);
        expect(outcome).toMatchObject({ passed: false, reportRejected: true });
        expect(outcome.failures.join('\n')).toContain(message);
    });

    it('fails a walk that changed files', async () => {
        const outcome = await verify(walk({}), path => writeFile(join(path, 'src', 'page.tsx'), 'changed\n'));
        expect(outcome.failures).toEqual([expect.stringContaining('the walk changed files')]);
    });
});
