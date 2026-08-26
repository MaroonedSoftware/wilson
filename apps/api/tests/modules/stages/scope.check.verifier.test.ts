import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { BREADTH_THRESHOLD, ScopeCheckVerifier } from '#modules/stages/scope.check.verifier.js';
import type { ScopeCheckResult } from '#modules/stages/stage.result.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';

const exec = promisify(execFile);

/**
 * `ScopeCheckVerifier.verify` exercised against a real git worktree, the same way
 * `review.verifier.test.ts` exercises `ReviewVerifier` — the "did the stage write anything" check is
 * precisely what git reports, so a mock would only prove the test agrees with itself.
 *
 * The three calibration fixtures below (0075, 0078, 0079) are reconstructions, not the literal
 * historical plan text: the board's plan documents live in a separate repo this code repo has no
 * access to, and 0075's original plan was replaced by a smaller one when a human split it into 0075
 * and 0080 (git history here only has the post-split version). Each fixture is built from what this
 * codebase's own merged commits record those cards actually did — 34878eb / 476d723 ("the API write
 * surface": create, edit, move, plus 0080's five transition mutations — eight endpoints in total),
 * 360b8f6 ("0078: implementing", the eight CLI commands whose tests it repaired: ack, approve,
 * board.init, board.ready, move, release, show, start), and a669b9b / 360b8f6's "Doctor" note (0079
 * rewrote the board.ready health check and deleted the retired run command) — cross-referenced with
 * card 0105's own stated bullet/character counts for each. They stand in for "given that card's plan
 * text" in the sense that matters here: they are what a model correctly reading that plan would
 * report.
 */
describe('ScopeCheckVerifier', () => {
    let manager: WorktreeManager;
    let verifier: ScopeCheckVerifier;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'scope-check-verifier-'));
        const codeRoot = join(base, 'code');
        await mkdir(codeRoot, { recursive: true });
        await writeFile(join(codeRoot, 'README.md'), 'placeholder\n', 'utf8');
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const config = new StaticBoardConfig('test', join(base, 'board'), codeRoot, join(base, 'worktrees'), join(base, 'run'));
        const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
        manager = new WorktreeManager(config, silentLogger as never);
        verifier = new ScopeCheckVerifier(manager);
    });

    const verify = async (result: unknown) => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        return verifier.verify({ worktree, stage: {} as never, cardId: '0001', scope: {} as never, result });
    };

    /**
     * Card 0075's original (pre-split) plan: eight tasks each adding one more write endpoint, plus
     * one shared-plumbing task — nine bullets total, matching card 0105's own measurement
     * ("9 bullets, 5,141 chars"). This is the case card 0105's Constraints singles out by name: the
     * refusal must name the repetition, not the bullet count or the character count, which are
     * unremarkable and would flag nothing on their own.
     */
    const card0075: ScopeCheckResult = {
        summary: 'eight write endpoints, one shared contracts task',
        groups: [
            {
                title: 'add a write endpoint',
                tasks: [
                    'create card endpoint',
                    'edit card endpoint',
                    'move card endpoint',
                    'approve card endpoint',
                    'release card endpoint',
                    'depend card endpoint',
                    'ack card endpoint',
                    'start card endpoint',
                ],
            },
            { title: 'shared request/response contracts', tasks: ['define named request/response contracts shared by every endpoint'] },
        ],
        verdict: 'refuse',
        reason:
            'eight of the nine tasks each add one more write endpoint — the same kind of thing done eight times over. ' +
            'Nine bullets and roughly five thousand characters are unremarkable by themselves; the repetition is what does not fit one pass.',
        division: [
            {
                title: 'card lifecycle writes',
                tasks: ['create card endpoint', 'edit card endpoint', 'move card endpoint', 'depend card endpoint'],
                delivers: 'create, edit, move and depend as an API write surface',
            },
            {
                title: 'card lifecycle transitions',
                tasks: ['approve card endpoint', 'release card endpoint', 'ack card endpoint', 'start card endpoint'],
                delivers: 'approve, release, ack and start as an API write surface',
            },
        ],
    };

    /** Card 0078: every CLI command ported to the API-backed transport — eight of them, one bullet each. */
    const card0078: ScopeCheckResult = {
        summary: 'eight commands ported to the API transport',
        groups: [
            {
                title: 'port a CLI command to the API transport',
                tasks: ['port ack', 'port approve', 'port board.init', 'port board.ready', 'port move', 'port release', 'port show', 'port start'],
            },
            { title: 'remove now-dead CLI-side business logic', tasks: ['delete the container/pg-backed logic the SDK path supersedes'] },
        ],
        verdict: 'refuse',
        reason:
            'eight of the nine tasks port one more command to the new transport — the same kind of thing eight times over, ' +
            'not the nine bullets or 6,350 characters this plan happens to run.',
        division: [
            {
                title: 'read and setup commands',
                tasks: ['port ack', 'port approve', 'port board.init', 'port board.ready'],
                delivers: 'ack, approve, board.init and board.ready ported to the API transport',
            },
            {
                title: 'lifecycle commands',
                tasks: ['port move', 'port release', 'port show', 'port start'],
                delivers: 'move, release, show and start ported to the API transport',
            },
        ],
    };

    /**
     * Card 0079: the largest plan on the board by bullet count and character count (21 bullets,
     * 12,036 chars) — three distinct things, each done once. This is the important negative case: a
     * check that cannot tell this apart from 0075/0078 is measuring size, not breadth, and would be
     * wrong in the expensive direction (refusing the one plan card 0105 explicitly requires to pass).
     */
    const card0079: ScopeCheckResult = {
        summary: 'one health check rewritten, one command deleted, one set of comments fixed',
        groups: [
            { title: 'rewrite the board.ready health check to ask the API for the card count', tasks: ['rewrite board.ready'] },
            { title: 'delete the retired run command', tasks: ['delete run.command.ts and its two tombstone tests'] },
            { title: 'fix stale comments describing what still needs the CLI bootstrap', tasks: ['fix index.ts/plan.command.ts comments'] },
        ],
        verdict: 'pass',
        reason:
            'three different things, each done once — one health check rewritten, one command deleted, one set of comments fixed. ' +
            'Twenty-one bullets and 12,036 characters come from how much each is spelled out, not from doing any of them more than once.',
        division: [],
    };

    it('refuses card 0075, naming the repetition rather than the bullet or character count', async () => {
        const outcome = await verify(card0075);

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toEqual([]);
        expect(card0075.reason).toContain('eight');
        expect(card0075.reason).toMatch(/repetition/);
        expect(card0075.division.length).toBeGreaterThanOrEqual(2);
        for (const piece of card0075.division) {
            expect(piece.delivers.trim().length).toBeGreaterThan(0);
        }
    });

    it('refuses card 0078', async () => {
        const outcome = await verify(card0078);

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toEqual([]);
    });

    // The important case (see the fixture's own comment): 0079 is the largest plan on the board, and
    // a breadth check that mistakes size for repetition would refuse it. It must pass.
    it('passes card 0079 despite being the largest plan on the board', async () => {
        const outcome = await verify(card0079);

        expect(outcome.passed).toBe(true);
        expect(outcome.failures).toEqual([]);
    });

    it('rejects a "pass" that contradicts its own reported breadth', async () => {
        const outcome = await verify({ ...card0075, verdict: 'pass', division: [] });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toHaveLength(1);
        expect(outcome.failures[0]).toContain(`>= ${BREADTH_THRESHOLD}`);
        expect(outcome.failures[0]).toContain('"pass"');
    });

    it('rejects a "refuse" backed by no reported breadth', async () => {
        const division = [
            { title: 'health', tasks: ['rewrite board.ready'], delivers: 'the rewritten health check alone' },
            { title: 'cleanup', tasks: ['delete run.command.ts and its two tombstone tests'], delivers: 'the deletion alone' },
        ];
        const outcome = await verify({ ...card0079, verdict: 'refuse', division });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toHaveLength(1);
        expect(outcome.failures[0]).toContain('no group repeats');
    });

    it('accepts a division piece that depends on another piece in the same division', async () => {
        const outcome = await verify({
            ...card0075,
            division: [card0075.division[0], { ...card0075.division[1], dependsOn: [card0075.division[0].title] }],
        });

        expect(outcome.passed).toBe(false); // still routes to "refuse" (see class doc comment), not a stage failure
        expect(outcome.failures).toEqual([]);
    });

    it('rejects a division piece that names itself as a dependency', async () => {
        const outcome = await verify({
            ...card0075,
            division: [card0075.division[0], { ...card0075.division[1], dependsOn: [card0075.division[1].title] }],
        });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('lists itself as a dependency'))).toBe(true);
    });

    it('rejects a division piece whose dependency is not one of this division’s own pieces', async () => {
        const outcome = await verify({
            ...card0075,
            division: [card0075.division[0], { ...card0075.division[1], dependsOn: ['a piece nobody proposed'] }],
        });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('a piece nobody proposed'))).toBe(true);
    });

    it('rejects a refusal whose division cites a task no group reported', async () => {
        const outcome = await verify({
            ...card0075,
            division: [
                ...card0075.division.slice(1),
                { title: 'invented piece', tasks: ['a task nobody reported'], delivers: 'nothing real' },
            ],
        });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('a task nobody reported'))).toBe(true);
    });

    it('rejects a refusal proposing only one piece, at the schema level', async () => {
        const outcome = await verify({ ...card0075, division: [card0075.division[0]] });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures[0]).toContain('does not match the scope-check schema');
    });

    it('rejects a "pass" that still carries a division', async () => {
        const outcome = await verify({ ...card0079, division: card0078.division });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toContain('verdict is "pass" but a division was proposed; a pass should carry none');
    });

    it('rejects a result whose reason is empty, since "planning" would have nothing to start from', async () => {
        const outcome = await verify({ ...card0079, reason: '   ' });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('reason is empty'))).toBe(true);
    });

    /**
     * `BREADTH_THRESHOLD` (4) is the exact line the verifier draws between "unremarkable pair or
     * trio" and "too broad". The 0075/0078 fixtures above clear it by a wide margin (eight-wide
     * groups); this checks the boundary itself: a group one below the threshold must not force a
     * refusal, and a group exactly at the threshold must.
     */
    it('passes a "pass" whose widest group sits one below the threshold', async () => {
        const belowThreshold: ScopeCheckResult = {
            ...card0079,
            groups: [{ title: 'add a read-only report field', tasks: ['field a', 'field b', 'field c'] }],
            verdict: 'pass',
            reason: 'three near-identical fields, one below this stage\'s repetition threshold.',
        };

        const outcome = await verify(belowThreshold);

        expect(outcome.passed).toBe(true);
        expect(outcome.failures).toEqual([]);
    });

    it('requires "refuse" once the widest group reaches the threshold exactly', async () => {
        const atThreshold: ScopeCheckResult = {
            ...card0079,
            groups: [{ title: 'add a read-only report field', tasks: ['field a', 'field b', 'field c', 'field d'] }],
            verdict: 'pass',
            reason: 'four near-identical fields.',
        };

        const outcome = await verify(atThreshold);

        expect(outcome.passed).toBe(false);
        expect(outcome.failures[0]).toContain(`>= ${BREADTH_THRESHOLD}`);
        expect(outcome.failures[0]).toContain('"pass"');
    });

    it('fails a stage that wrote to its read-only worktree, independent of its reported verdict', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await writeFile(join(worktree.path, 'README.md'), 'changed\n', 'utf8');

        const outcome = await verifier.verify({ worktree, stage: {} as never, cardId: '0001', scope: {} as never, result: card0079 });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('read-only judge must not do'))).toBe(true);
    });
});
