import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { BREADTH_THRESHOLD, DEPTH_THRESHOLD, FANOUT_THRESHOLD, ScopeCheckVerifier } from '#modules/stages/scope.check.verifier.js';
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

        const config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
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
                // One route file per endpoint — well below FANOUT_THRESHOLD, so this fixture's
                // breadth-only assertions below are not also tripped by fan-out.
                sites: 3,
            },
            {
                title: 'shared request/response contracts',
                tasks: ['define named request/response contracts shared by every endpoint'],
                sites: 1,
            },
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
                sites: 2,
            },
            {
                title: 'remove now-dead CLI-side business logic',
                tasks: ['delete the container/pg-backed logic the SDK path supersedes'],
                sites: 1,
            },
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
            { title: 'rewrite the board.ready health check to ask the API for the card count', tasks: ['rewrite board.ready'], sites: 1 },
            {
                title: 'delete the retired run command',
                tasks: ['delete run.command.ts and its two tombstone tests'],
                sites: 3,
            },
            {
                title: 'fix stale comments describing what still needs the CLI bootstrap',
                tasks: ['fix index.ts/plan.command.ts comments'],
                sites: 2,
            },
        ],
        verdict: 'pass',
        reason:
            'three different things, each done once — one health check rewritten, one command deleted, one set of comments fixed. ' +
            'Twenty-one bullets and 12,036 characters come from how much each is spelled out, not from doing any of them more than once.',
        division: [],
    };

    /**
     * Card 0120: the case that motivated `DEPTH_THRESHOLD` (see that constant's doc comment) — nine
     * groups, each holding exactly one task, so `largestGroup` never comes close to
     * `BREADTH_THRESHOLD`. Schema migration, DB type binding, repository, conversation agent, session
     * registry, SSE feed, service integration, contract declaration, route mounting.
     */
    const card0120: ScopeCheckResult = {
        summary: 'nine distinct pieces: schema, DB binding, repository, agent, registry, SSE feed, service, contract, route',
        groups: [
            { title: 'schema migration', tasks: ['add the new columns'], sites: 1 },
            { title: 'DB type binding', tasks: ['bind the new columns to db types'], sites: 1 },
            { title: 'repository', tasks: ['add repository methods for the new columns'], sites: 1 },
            { title: 'conversation agent', tasks: ['wire the agent prompt'], sites: 1 },
            { title: 'session registry', tasks: ['register the new session kind'], sites: 1 },
            { title: 'SSE feed', tasks: ['stream the new events over SSE'], sites: 1 },
            { title: 'service integration', tasks: ['integrate the new service'], sites: 1 },
            { title: 'contract declaration', tasks: ['declare the new contract'], sites: 1 },
            { title: 'route mounting', tasks: ['mount the new route'], sites: 1 },
        ],
        verdict: 'pass',
        reason: 'nine different pieces, each done once — no group repeats.',
        division: [],
    };

    /**
     * Card 0153's shape (see `FANOUT_THRESHOLD`'s own doc comment): one Tasks-section item — "update
     * every internal link" — whose work actually lands in ten files. Breadth (`tasks.length` is 1) and
     * depth (one group) both read straight past this; `sites` is the only place the real fan-out is
     * visible at all.
     */
    const card0153: ScopeCheckResult = {
        summary: 'one link-migration task that touches every internal link in the app',
        groups: [{ title: 'update every internal link', tasks: ['update every internal link'], sites: 10 }],
        verdict: 'refuse',
        reason: "one task, but it touches roughly ten files — the same shape that exhausted card 0151's step budget nine times over.",
        division: [
            { title: 'nav-rendering links', tasks: ['update every internal link'], delivers: 'the nav-rendering half of the link migration' },
            { title: 'remaining links', tasks: ['update every internal link'], delivers: 'the rest of the link migration' },
        ],
    };

    it('refuses card 0075, naming the repetition rather than the bullet or character count', async () => {
        const outcome = await verify(card0075);

        expect(outcome.passed).toBe(false);
        // A well-formed refusal still pushes exactly one failure, naming the reason — that is what
        // makes the dispatcher's own `failures.length === 0` routing check false and sends the card to
        // `planning` instead of `implementing` (see `ScopeCheckVerifier`'s class doc comment).
        expect(outcome.failures).toEqual([`refusing: ${card0075.reason}`]);
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
        expect(outcome.failures).toEqual([`refusing: ${card0078.reason}`]);
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

    it('does not block routing on a "refuse" backed by no reported breadth or depth (card 0157)', async () => {
        const division = [
            { title: 'health', tasks: ['rewrite board.ready'], delivers: 'the rewritten health check alone' },
            { title: 'cleanup', tasks: ['delete run.command.ts and its two tombstone tests'], delivers: 'the deletion alone' },
        ];
        const outcome = await verify({ ...card0079, verdict: 'refuse', division });

        // `passed` still reads false for any "refuse" (see the class doc comment) — it tracks a clean,
        // uncontradicted "pass", not whether the card advances. Routing is decided by `failures` alone,
        // and here it must come back empty: neither breadth nor depth backs this refusal, so this stage
        // no longer obeys it (card 0157 — 0153/0155/0156 were bounced back to `planning` by exactly
        // this before the fix, despite the model having correctly out-argued the metric).
        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toEqual([]);
    });

    it('accepts a division piece that depends on another piece in the same division', async () => {
        const dividedCard = {
            ...card0075,
            division: [card0075.division[0], { ...card0075.division[1], dependsOn: [card0075.division[0].title] }],
        };
        const outcome = await verify(dividedCard);

        // Routes to "refuse" (see class doc comment): a well-formed refusal still pushes its own
        // "refusing: ..." entry, which is what fails the dispatcher's routing check on purpose — it is
        // not a stage failure about the report's internal consistency, which is what this test checks.
        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toEqual([`refusing: ${dividedCard.reason}`]);
    });

    describe('supportedRefusal', () => {
        it('carries the division when the refusal is the only failure', async () => {
            const outcome = await verify(card0075);

            expect(outcome.supportedRefusal?.reason).toBe(card0075.reason);
            expect(outcome.supportedRefusal?.division.map(piece => piece.title)).toEqual(card0075.division.map(piece => piece.title));
        });

        it('is absent when a division cites an invented task, even though the refusal still routes', async () => {
            const outcome = await verify({
                ...card0075,
                division: [{ ...card0075.division[0], tasks: ['a task nobody reported'] }, card0075.division[1]],
            });

            expect(outcome.failures.some(failure => failure.startsWith('refusing:'))).toBe(true);
            expect(outcome.supportedRefusal).toBeUndefined();
        });

        it('is absent on an unsupported refusal, which advances instead', async () => {
            const division = card0075.division;
            const outcome = await verify({ ...card0079, verdict: 'refuse', division: [division[0], division[1]] });

            expect(outcome.supportedRefusal).toBeUndefined();
        });

        it('is absent on a pass', async () => {
            expect((await verify(card0079)).supportedRefusal).toBeUndefined();
        });
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

    describe('citing numbered tasks', () => {
        const numbered: ScopeCheckResult = {
            ...card0075,
            groups: [
                {
                    title: 'add a write endpoint',
                    tasks: [
                        '1. create card endpoint in board.router.ts',
                        '2) edit card endpoint',
                        '3: move card endpoint',
                        '4. depend card endpoint',
                    ],
                    sites: 4,
                },
            ],
        };

        // Card 0004: the groups quoted each task in full and the division abbreviated the same numbers.
        it('accepts a division that abbreviates a numbered task', async () => {
            const outcome = await verify({
                ...numbered,
                division: [
                    { title: 'first half', tasks: ['1. create', '2'], delivers: 'create and edit' },
                    { title: 'second half', tasks: ['3. move', '4. depend'], delivers: 'move and depend' },
                ],
            });

            expect(outcome.failures).toEqual([`refusing: ${numbered.reason}`]);
            expect(outcome.supportedRefusal?.division).toHaveLength(2);
        });

        it('still rejects a number no group reported', async () => {
            const outcome = await verify({
                ...numbered,
                division: [
                    { title: 'first half', tasks: ['5. create'], delivers: 'create' },
                    { title: 'second half', tasks: ['3. move', '4. depend'], delivers: 'move and depend' },
                ],
            });

            expect(outcome.failures.some(f => f.includes('"5. create"'))).toBe(true);
            expect(outcome.supportedRefusal).toBeUndefined();
        });

        it('reads a leading number as a task number only when it is punctuated as one', async () => {
            const outcome = await verify({
                ...numbered,
                division: [
                    { title: 'first half', tasks: ['1 endpoint'], delivers: 'create' },
                    { title: 'second half', tasks: ['3. move', '4. depend'], delivers: 'move and depend' },
                ],
            });

            expect(outcome.failures.some(f => f.includes('"1 endpoint"'))).toBe(true);
        });
    });

    it('rejects a refusal whose division cites a task no group reported', async () => {
        const outcome = await verify({
            ...card0075,
            division: [...card0075.division.slice(1), { title: 'invented piece', tasks: ['a task nobody reported'], delivers: 'nothing real' }],
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
            groups: [{ title: 'add a read-only report field', tasks: ['field a', 'field b', 'field c'], sites: 3 }],
            verdict: 'pass',
            reason: "three near-identical fields, one below this stage's repetition threshold.",
        };

        const outcome = await verify(belowThreshold);

        expect(outcome.passed).toBe(true);
        expect(outcome.failures).toEqual([]);
    });

    it('requires "refuse" once the widest group reaches the threshold exactly', async () => {
        const atThreshold: ScopeCheckResult = {
            ...card0079,
            groups: [{ title: 'add a read-only report field', tasks: ['field a', 'field b', 'field c', 'field d'], sites: 4 }],
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

    /**
     * Card 0004's shape: many groups, none wide or fanned out. Depth supports a refusal but does not
     * contradict a pass, because whether many kinds of work belong together is the model's call
     * (`DEPTH_THRESHOLD`'s doc comment). Card 0120's fixture has the same shape, so it stands in here.
     */
    it('accepts a "pass" past the depth threshold when neither breadth nor fan-out fired (card 0004)', async () => {
        expect(card0120.groups.length).toBeGreaterThanOrEqual(DEPTH_THRESHOLD);

        const outcome = await verify(card0120);

        expect(outcome.passed).toBe(true);
        expect(outcome.failures).toEqual([]);
    });

    it('accepts a "refuse" on card 0120\'s nine-group shape, with no consistency failure beyond the routing one', async () => {
        const division = [
            {
                title: 'data layer',
                tasks: ['add the new columns', 'bind the new columns to db types', 'add repository methods for the new columns'],
                delivers: 'the schema, DB binding and repository, working together',
            },
            {
                title: 'runtime wiring',
                tasks: [
                    'wire the agent prompt',
                    'register the new session kind',
                    'stream the new events over SSE',
                    'integrate the new service',
                    'declare the new contract',
                    'mount the new route',
                ],
                delivers: 'the agent, registry, SSE feed, service, contract and route, working together',
                dependsOn: ['data layer'],
            },
        ];
        const outcome = await verify({ ...card0120, verdict: 'refuse', reason: 'nine distinct pieces collected into one card.', division });

        expect(outcome.passed).toBe(false);
        // No breadth/depth consistency failure — depth fired and the verdict is "refuse", so that
        // signal agrees with the report. The only entry is the unconditional routing failure every
        // well-formed "refuse" carries (see the class doc comment).
        expect(outcome.failures).toEqual(['refusing: nine distinct pieces collected into one card.']);
    });

    it('still rejects a too-broad "pass" when it is also too deep, naming only breadth', async () => {
        const bothTooLarge: ScopeCheckResult = {
            ...card0120,
            groups: [
                { title: 'add a write endpoint', tasks: ['a', 'b', 'c', 'd'], sites: 4 },
                // Enough further groups that the depth signal fires too — derived from the constant
                // rather than a literal, so raising or lowering it keeps this a both-signals case.
                ...card0120.groups.slice(1, DEPTH_THRESHOLD),
            ],
        };

        const outcome = await verify(bothTooLarge);

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toHaveLength(1);
        expect(outcome.failures[0]).toContain(`>= ${BREADTH_THRESHOLD}`);
        expect(outcome.failures[0]).toContain('repeats across');
    });

    it("still passes card 0079's three-group shape now that depth is checked too", async () => {
        const outcome = await verify(card0079);

        expect(outcome.passed).toBe(true);
        expect(outcome.failures).toEqual([]);
    });

    it('still reports unrelated division defects on an unsupported "refuse", even though the routing failure no longer fires (card 0157)', async () => {
        const division = [
            { title: 'health', tasks: ['rewrite board.ready'], delivers: 'the rewritten health check alone' },
            // Two genuine division defects — an empty `delivers` and a piece depending on itself —
            // unrelated to breadth/depth, to prove the card 0157 change only silences the two pushes
            // that read `tooLarge`, not the rest of this method's consistency checking.
            { title: 'cleanup', tasks: ['delete run.command.ts and its two tombstone tests'], delivers: '', dependsOn: ['cleanup'] },
        ];
        const outcome = await verify({ ...card0079, verdict: 'refuse', division });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('does not say what it would deliver on its own'))).toBe(true);
        expect(outcome.failures.some(f => f.includes('lists itself as a dependency'))).toBe(true);
        // Neither the old mirror-case complaint nor the routing push survives an unsupported refusal.
        expect(outcome.failures.some(f => f.includes('neither breadth nor depth'))).toBe(false);
        expect(outcome.failures.some(f => f.startsWith('refusing:'))).toBe(false);
    });

    /**
     * Card 0157's own boundary: the "refusing: ..." push now reads the same `tooLarge` the
     * consistency check above computes, rather than firing on `verdict === 'refuse'` alone. These two
     * tests pin that condition at the exact line `BREADTH_THRESHOLD`/`DEPTH_THRESHOLD` draw — a
     * *supported* refusal must still push and still route to `planning`, exactly as it did before this
     * card (first Acceptance criterion; card 0120 must keep being caught).
     */
    it('pushes the routing failure for a "refuse" whose widest group meets the breadth threshold exactly', async () => {
        const atThreshold: ScopeCheckResult = {
            summary: 'four near-identical fields',
            groups: [{ title: 'add a read-only report field', tasks: ['field a', 'field b', 'field c', 'field d'], sites: 4 }],
            verdict: 'refuse',
            reason: 'four near-identical fields — the same kind of thing repeated four times.',
            division: [
                { title: 'fields a and b', tasks: ['field a', 'field b'], delivers: 'fields a and b, working alone' },
                { title: 'fields c and d', tasks: ['field c', 'field d'], delivers: 'fields c and d, working alone' },
            ],
        };
        expect(atThreshold.groups[0].tasks).toHaveLength(BREADTH_THRESHOLD);

        const outcome = await verify(atThreshold);

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toEqual([`refusing: ${atThreshold.reason}`]);
    });

    it('pushes the routing failure for a "refuse" whose group count meets the depth threshold exactly', async () => {
        const half = DEPTH_THRESHOLD / 2;
        const atThreshold: ScopeCheckResult = {
            ...card0120,
            groups: card0120.groups.slice(0, DEPTH_THRESHOLD),
            verdict: 'refuse',
            reason: `${DEPTH_THRESHOLD} distinct pieces collected into one card.`,
            division: [
                { title: 'first half', tasks: card0120.groups.slice(0, half).flatMap(g => g.tasks), delivers: 'the first half, working alone' },
                {
                    title: 'second half',
                    tasks: card0120.groups.slice(half, DEPTH_THRESHOLD).flatMap(g => g.tasks),
                    delivers: 'the second half, working alone',
                },
            ],
        };
        expect(atThreshold.groups).toHaveLength(DEPTH_THRESHOLD);

        const outcome = await verify(atThreshold);

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toEqual([`refusing: ${atThreshold.reason}`]);
    });

    it('does not push the routing failure for a "refuse" whose group count sits one below the depth threshold (card 0157)', async () => {
        const belowThreshold: ScopeCheckResult = {
            ...card0120,
            groups: card0120.groups.slice(0, DEPTH_THRESHOLD - 1),
            verdict: 'refuse',
            reason: `${DEPTH_THRESHOLD - 1} distinct pieces collected into one card.`,
            division: [
                { title: 'first half', tasks: card0120.groups.slice(0, 2).flatMap(g => g.tasks), delivers: 'the first half, working alone' },
                {
                    title: 'second half',
                    tasks: card0120.groups.slice(2, DEPTH_THRESHOLD - 1).flatMap(g => g.tasks),
                    delivers: 'the second half, working alone',
                },
            ],
        };
        expect(belowThreshold.groups).toHaveLength(DEPTH_THRESHOLD - 1);

        const outcome = await verify(belowThreshold);

        // Neither signal is met, so this refusal is unfounded by this stage's own evidence: no
        // "refusing: ..." push, `failures` comes back empty, and the card is free to advance instead
        // of bouncing back to `planning` (card 0157's whole point).
        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toEqual([]);
    });

    /**
     * `FANOUT_THRESHOLD` (card 0158): the signal that reads each group's own reported `sites` count
     * rather than its `tasks.length`. Card 0153's shape is the reason it exists — one Tasks-section
     * item whose work lands in ten files, a shape breadth and depth both read straight past (see the
     * `card0153` fixture's own comment and `FANOUT_THRESHOLD`'s doc comment).
     */
    it('rejects a "pass" backed by card 0153\'s shape, naming fan-out rather than breadth or depth', async () => {
        const outcome = await verify({ ...card0153, verdict: 'pass', division: [] });

        // Only the fan-out signal fired (one task, one group, but many sites) — breadth and depth
        // both see nothing remarkable, so exactly one failure, and it must name the group and its
        // site count rather than tasks or groups.
        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toHaveLength(1);
        expect(outcome.failures[0]).toContain(card0153.groups[0].title);
        expect(outcome.failures[0]).toContain(`${card0153.groups[0].sites} places`);
        expect(outcome.failures[0]).toContain(`>= ${FANOUT_THRESHOLD}`);
        expect(outcome.failures[0]).toContain('"pass"');
    });

    it('pushes the routing failure for a "refuse" supported only by fan-out (card 0153\'s shape)', async () => {
        const outcome = await verify(card0153);

        // A supported refusal still pushes and still routes to `planning`, exactly as a
        // breadth- or depth-supported refusal already does (card 0157's "supported" branch) — fan-out
        // is a third way to earn that support, not a different consequence.
        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toEqual([`refusing: ${card0153.reason}`]);
    });

    it("still passes card 0079's three-group shape now that fan-out is checked too", async () => {
        const outcome = await verify(card0079);

        expect(outcome.passed).toBe(true);
        expect(outcome.failures).toEqual([]);
    });

    /**
     * The fan-out boundary, the same way the breadth and depth boundaries above are pinned: one site
     * below `FANOUT_THRESHOLD` must not force a refusal, and exactly at it must.
     */
    it('passes a "pass" whose widest group sits one site below the fan-out threshold', async () => {
        const belowThreshold: ScopeCheckResult = {
            ...card0079,
            groups: [{ title: 'update every internal link', tasks: ['update every internal link'], sites: FANOUT_THRESHOLD - 1 }],
            verdict: 'pass',
            reason: "one task touching several files, one below this stage's fan-out threshold.",
        };

        const outcome = await verify(belowThreshold);

        expect(outcome.passed).toBe(true);
        expect(outcome.failures).toEqual([]);
    });

    it('requires "refuse" once a group\'s reported site count reaches the fan-out threshold exactly', async () => {
        const atThreshold: ScopeCheckResult = {
            ...card0079,
            groups: [{ title: 'update every internal link', tasks: ['update every internal link'], sites: FANOUT_THRESHOLD }],
            verdict: 'pass',
            reason: 'one task touching many files.',
        };

        const outcome = await verify(atThreshold);

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toHaveLength(1);
        expect(outcome.failures[0]).toContain(`>= ${FANOUT_THRESHOLD}`);
        expect(outcome.failures[0]).toContain('"pass"');
    });

    it('does not push the routing failure for a "refuse" whose site count sits one below the fan-out threshold', async () => {
        const belowThreshold: ScopeCheckResult = {
            ...card0079,
            groups: [{ title: 'update every internal link', tasks: ['update every internal link'], sites: FANOUT_THRESHOLD - 1 }],
            verdict: 'refuse',
            reason: 'one task touching several files, but not enough to justify refusing on its own.',
            division: [
                { title: 'first half', tasks: ['update every internal link'], delivers: 'half the links, working alone' },
                { title: 'second half', tasks: ['update every internal link'], delivers: 'the rest of the links, working alone' },
            ],
        };

        const outcome = await verify(belowThreshold);

        // No signal is met (one task, one group, one below the fan-out line), so this stage does not
        // believe its own refusal (card 0157's mirror case) — no "refusing: ..." push, `failures`
        // empty, the card is free to advance.
        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toEqual([]);
    });

    it('names breadth and fan-out when a "pass" is too broad, too deep, and too fanned out at once', async () => {
        const allThreeTooLarge: ScopeCheckResult = {
            ...card0120,
            groups: [
                { title: 'add a write endpoint', tasks: ['a', 'b', 'c', 'd'], sites: FANOUT_THRESHOLD },
                ...card0120.groups.slice(1, DEPTH_THRESHOLD),
            ],
        };

        const outcome = await verify(allThreeTooLarge);

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toHaveLength(2);
        expect(outcome.failures[0]).toContain(`>= ${BREADTH_THRESHOLD}`);
        expect(outcome.failures[0]).toContain('repeats across');
        expect(outcome.failures[1]).toContain(`>= ${FANOUT_THRESHOLD}`);
        expect(outcome.failures[1]).toContain('places');
    });

    /**
     * `ScopeGroupSchema`'s `sites` field (card 0158) is required and must be at least 1 — a group
     * reporting no site count, or reporting zero, is a malformed result the same way a division with
     * only one piece already is above.
     */
    it('rejects a group that reports no site count at all', async () => {
        const groupWithoutSites = { title: card0079.groups[0].title, tasks: card0079.groups[0].tasks };
        const outcome = await verify({ ...card0079, groups: [groupWithoutSites, ...card0079.groups.slice(1)] });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures[0]).toContain('does not match the scope-check schema');
    });

    it('rejects a group whose reported site count is below the schema minimum of one', async () => {
        const outcome = await verify({ ...card0079, groups: [{ ...card0079.groups[0], sites: 0 }, ...card0079.groups.slice(1)] });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures[0]).toContain('does not match the scope-check schema');
    });
});
