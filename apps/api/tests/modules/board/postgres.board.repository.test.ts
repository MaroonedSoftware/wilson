import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '@maroonedsoftware/logger';
import { PostgresBoardRepository, CardNotFoundError } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { EventLog } from '#modules/events/event.log.js';
import { parseStages, type ProjectStages } from '#modules/stages/stage.config.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { Card } from '#modules/board/card.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

const silentLogger: Logger = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
};

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const card = (id: string, overrides: Partial<Card['frontmatter']> = {}, body = '## Goal\n\nDo it.\n'): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'parking-lot', dependsOn: [], retries: {}, ...overrides },
    sections: {},
    body,
});

describe('PostgresBoardRepository', () => {
    let board: PostgresBoardRepository;
    let config: StaticBoardConfig;

    beforeEach(() => {
        const events = { append: async () => {} };
        config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    });

    /**
     * The bug that motivated the primary key. The file-backed board used `writeFile`, which
     * overwrites, so two writers each allocating "the next id" against their own view of the
     * directory destroyed one another's work silently — it happened to a real card. The database
     * refuses instead, and a caller that wanted to create gets an error rather than a casualty.
     */
    it('refuses to create a card whose id is already taken, rather than overwriting it', async () => {
        await board.create(card('0001', { title: 'the original' }), 'create');

        await expect(board.create(card('0001', { title: 'the impostor' }), 'create')).rejects.toThrow();

        expect((await board.read('0001')).frontmatter.title).toBe('the original');
    });

    it('reads back what it created, sections included', async () => {
        await board.create(card('0001', {}, '## Goal\n\nShip it.\n\n## Files in scope\n\n- src/a.ts\n'), 'create');

        const stored = await board.read('0001');
        expect(stored.frontmatter.title).toBe('card 0001');
        expect(stored.sections['Files in scope']).toBe('- src/a.ts');
    });

    it('throws for a card that does not exist rather than returning an empty one', async () => {
        await expect(board.read('9999')).rejects.toThrow(CardNotFoundError);
    });

    /**
     * `readAt` replaces `git show <sha>:<path>`, and the dispatcher reads frontmatter from the
     * pinned card — `assertDispatchable` checks its stage, the branch name comes from its title. A
     * version that stored only the plan body would silently change dispatch semantics.
     */
    it('pins frontmatter as well as body, so a later edit does not reach a running stage', async () => {
        const first = await board.create(card('0001', { stage: 'implementing' }, 'original body\n'), 'create');

        await board.write('0001', 'move it', c => ({
            ...c,
            frontmatter: { ...c.frontmatter, stage: 'review', title: 'renamed' },
            body: 'rewritten body\n',
        }));

        const pinned = await board.readAt('0001', first);
        expect(pinned.frontmatter.stage).toBe('implementing');
        expect(pinned.frontmatter.title).toBe('card 0001');
        expect(pinned.body).toBe('original body\n');

        const now = await board.read('0001');
        expect(now.frontmatter.stage).toBe('review');
        expect(now.body).toBe('rewritten body\n');
    });

    it('hands the mutate callback the card as it is now, not as the caller last saw it', async () => {
        await board.create(card('0001', { retries: { review: 1 } }), 'create');
        await board.write('0001', 'bump', c => ({
            ...c,
            frontmatter: { ...c.frontmatter, retries: { review: (c.frontmatter.retries.review ?? 0) + 1 } },
        }));

        await board.write('0001', 'bump again', c => ({
            ...c,
            frontmatter: { ...c.frontmatter, retries: { review: (c.frontmatter.retries.review ?? 0) + 1 } },
        }));

        expect((await board.read('0001')).frontmatter.retries).toEqual({ review: 3 });
    });

    /**
     * `card_versions.id` is `BIGSERIAL` and the driver returns a `BigInt`, while `DB` declares the
     * column as `string`. Hand-written database types cannot be checked against the database, so
     * nothing catches the difference until `JSON.stringify` refuses the value — which is how
     * `/api/cards/{id}/versions` returned a 500 having passed implementing, testing and review.
     * Asserting the type directly is the only check that fails before an HTTP response does.
     */
    it('returns version ids as strings, so they survive being serialized', async () => {
        await board.create(card('0001'), 'create');
        await board.write('0001', 'edit', c => ({ ...c, body: 'changed\n' }));

        const versions = await board.versions('0001', 10);
        expect(versions).toHaveLength(2);
        for (const version of versions) expect(typeof version.id).toBe('string');
        expect(() => JSON.stringify(versions)).not.toThrow();

        expect(typeof (await board.currentVersion('0001'))).toBe('string');
        expect(typeof (await board.create(card('0002'), 'create'))).toBe('string');
    });

    it('reports the newest version, and every write adds one', async () => {
        const created = await board.create(card('0001'), 'create');
        expect(await board.currentVersion('0001')).toBe(created);

        const written = await board.write('0001', 'edit', c => ({ ...c, body: 'changed\n' }));
        expect(written).not.toBe(created);
        expect(await board.currentVersion('0001')).toBe(written);
    });

    it('writes needsHuman and its reason through create, and reads both back intact', async () => {
        await board.create(card('0001', { needsHuman: true, needsHumanReason: 'waiting on the customer' }), 'create');

        const stored = await board.read('0001');
        expect(stored.frontmatter.needsHuman).toBe(true);
        expect(stored.frontmatter.needsHumanReason).toBe('waiting on the customer');
    });

    it('defaults an absent flag to false and reads a null reason back as undefined, never null', async () => {
        await board.create(card('0001'), 'create');

        const stored = await board.read('0001');
        expect(stored.frontmatter.needsHuman).toBe(false);
        expect(stored.frontmatter.needsHumanReason).toBeUndefined();
        expect(stored.frontmatter.needsHumanReason).not.toBeNull();
    });

    it('carries needsHuman and its reason through a write, the same as create', async () => {
        await board.create(card('0001'), 'create');

        await board.write('0001', 'flag it', c => ({
            ...c,
            frontmatter: { ...c.frontmatter, needsHuman: true, needsHumanReason: 'blocked on a design call' },
        }));

        const stored = await board.read('0001');
        expect(stored.frontmatter.needsHuman).toBe(true);
        expect(stored.frontmatter.needsHumanReason).toBe('blocked on a design call');
    });

    it('refuses a dependency on a card that does not exist', async () => {
        await expect(board.create(card('0002', { dependsOn: ['9999'] }), 'create')).rejects.toThrow();
    });

    it('stores and removes dependencies as the card declares them', async () => {
        await board.create(card('0001'), 'create');
        await board.create(card('0002', { dependsOn: ['0001'] }), 'create');
        expect((await board.read('0002')).frontmatter.dependsOn).toEqual(['0001']);

        await board.write('0002', 'unblock', c => ({ ...c, frontmatter: { ...c.frontmatter, dependsOn: [] } }));
        expect((await board.read('0002')).frontmatter.dependsOn).toEqual([]);
    });

    /**
     * The reason the board moved into Postgres at all. Previously the card was committed to git and
     * the event appended here, so a failure between the two left them disagreeing permanently.
     */
    /**
     * Card 0128. `hasLiveClaim` is the `scopeConflict` fix's other half — read directly from
     * `runner.cardJobs` rather than through `CardJobs`, since `BoardRepository` has no dependency on
     * the jobs module. A row existing (however it got there) means true; nothing does, or nothing
     * any longer does, means false.
     */
    it('hasLiveClaim reports true only while a claim row exists for that card', async () => {
        await board.create(card('0001'), 'create');

        expect(await board.hasLiveClaim(config.project, '0001')).toBe(false);

        await db.insertInto('runner.cardJobs').values({ project: config.project, cardId: '0001', jobId: 'job-1' }).execute();
        expect(await board.hasLiveClaim(config.project, '0001')).toBe(true);

        await db.deleteFrom('runner.cardJobs').where('project', '=', config.project).where('cardId', '=', '0001').execute();
        expect(await board.hasLiveClaim(config.project, '0001')).toBe(false);
    });

    it('rolls the transition back when the event it is paired with fails', async () => {
        await board.create(card('0001', { stage: 'implementing' }), 'create');
        const exploding = {
            append: async () => {
                throw new Error('event log unavailable');
            },
        };
        const paired = new PostgresBoardRepository(config, db, exploding as unknown as EventLog);

        await expect(
            paired.writeWithEvent('0001', 'move it', c => ({ ...c, frontmatter: { ...c.frontmatter, stage: 'review' } }), {
                project: config.project,
                cardId: '0001',
                stage: 'implementing',
                type: 'transition.written',
                payload: {},
            }),
        ).rejects.toThrow('event log unavailable');

        // The move did not survive the event failing, which is the whole point of the pairing.
        expect((await board.read('0001')).frontmatter.stage).toBe('implementing');
    });

    /**
     * Card 0091. `setPosition` is deliberately not `write`: it must touch the `position` column and
     * nothing else, minting no version.
     */
    describe('setPosition', () => {
        it('updates only the position column, leaving title, stage and every other field untouched', async () => {
            await board.create(card('0001', { title: 'Untouched title', stage: 'parking-lot' }), 'create');
            const versionBefore = await board.currentVersion('0001');

            await board.setPosition('0001', 1500);

            const stored = await board.read('0001');
            expect(stored.frontmatter.position).toBe(1500);
            expect(stored.frontmatter.title).toBe('Untouched title');
            expect(stored.frontmatter.stage).toBe('parking-lot');
            // No version minted — the whole reason this is not `write`/`writeWithEvent`.
            expect(await board.currentVersion('0001')).toBe(versionBefore);
        });

        it('overwrites a previously set position rather than only ever setting it once', async () => {
            await board.create(card('0001'), 'create');
            await board.setPosition('0001', 1500);

            await board.setPosition('0001', 42);

            expect((await board.read('0001')).frontmatter.position).toBe(42);
        });

        it('scopes by project, leaving a same-id card in a different project alone', async () => {
            const otherConfig = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
            const otherBoard = new PostgresBoardRepository(otherConfig, db, { append: async () => {} } as unknown as EventLog);
            await board.create(card('0001'), 'create');
            await otherBoard.create(card('0001'), 'create');

            await board.setPosition('0001', 1500);

            expect((await board.read('0001')).frontmatter.position).toBe(1500);
            expect((await otherBoard.read('0001')).frontmatter.position).toBeUndefined();
        });

        it('persists through a freshly constructed repository against the same connection, the same as any other write', async () => {
            await board.create(card('0001'), 'create');

            await board.setPosition('0001', 777);

            const reread = new PostgresBoardRepository(config, db, { append: async () => {} } as unknown as EventLog);
            expect((await reread.read('0001')).frontmatter.position).toBe(777);
        });
    });

    /**
     * Card 0091. `list`'s `position, id` ordering predates this card, but nothing ever populated
     * `position` before `setPosition` existed — so this is the first test that actually exercises a
     * column mixing real positions with the untouched nulls every pre-existing card carries.
     */
    it('list sorts positioned cards ascending by position, ahead of unpositioned cards, which keep sorting by id', async () => {
        await board.create(card('0003', { stage: 'parking-lot' }), 'create');
        await board.create(card('0001', { stage: 'parking-lot' }), 'create');
        await board.create(card('0002', { stage: 'parking-lot' }), 'create');
        await board.create(card('0004', { stage: 'parking-lot' }), 'create');
        await board.setPosition('0002', 500);
        await board.setPosition('0004', 100);

        const ids = (await board.list()).map(c => c.frontmatter.id);

        expect(ids).toEqual(['0004', '0002', '0001', '0003']);
    });
});

/**
 * Card 0104. Two cards whose plans dispatch into the same files, with nothing deferring either.
 * `scopeConflict` is the check: exercised here against a real repository and a real `EventLog`,
 * rather than mocks, so `scope.granted` events (card 0069's `request_scope`) actually round-trip
 * through the same `EventLog.tail` a running dispatch would use.
 */
describe('PostgresBoardRepository.scopeConflict (card 0104)', () => {
    let board: PostgresBoardRepository;
    let config: StaticBoardConfig;
    let events: EventLog;
    let stages: ProjectStages;

    beforeEach(async () => {
        events = new EventLog(db, silentLogger);

        stages = parseStages(`
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: testing
    onFail: implementing
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: review
    onFail: implementing
  - name: review
    mode: manual
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: implementing
`);

        config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        board = new PostgresBoardRepository(config, db, events);
    });

    /**
     * Card 0128: `isRunningStage` alone no longer means "in flight" — a real claim row, the same
     * shape `CardJobs.record` leaves behind, is what every "defers" test below now needs on the
     * *other* card before `scopeConflict` will find it.
     */
    const claimCard = (project: string, cardId: string, jobId = `job-${cardId}`) =>
        db.insertInto('runner.cardJobs').values({ project, cardId, jobId }).execute();

    it('finds nothing when no other card is on the board', async () => {
        await board.create(card('0001', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/a.ts\n'), 'create');

        expect(await board.scopeConflict(events, config.project, await board.read('0001'), stages)).toBeUndefined();
    });

    it("defers on two cards' declared scope overlapping while both sit in an agent stage", async () => {
        await board.create(
            card('0001', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );
        await board.create(
            card('0002', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );
        await claimCard(config.project, '0001');

        const conflict = await board.scopeConflict(events, config.project, await board.read('0002'), stages);

        expect(conflict?.cardId).toBe('0001');
        expect(conflict?.overlap).toEqual([
            { ours: 'apps/api/src/modules/events/card.event.ts', theirs: 'apps/api/src/modules/events/card.event.ts' },
        ]);
    });

    /**
     * Card 0128. The gridlock itself: two cards sitting in agent stages with overlapping scope, but
     * neither one actually carried by a job — exactly what parked eight cards in `scope-check` with
     * nothing dispatchable. Before this card, `isRunningStage` alone was enough to make each defer on
     * the other forever; now, with no live claim on either side, `scopeConflict` must find nothing —
     * asserted from both directions, since either one could be the one a poller or `card start` asks.
     */
    it('finds no conflict between two cards parked in agent stages with overlapping scope and no live claims (the gridlock)', async () => {
        await board.create(
            card('0001', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );
        await board.create(
            card('0002', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );

        expect(await board.scopeConflict(events, config.project, await board.read('0001'), stages)).toBeUndefined();
        expect(await board.scopeConflict(events, config.project, await board.read('0002'), stages)).toBeUndefined();
    });

    /**
     * Card 0128's documented time-asymmetry: once 0001 is actually carried, 0002 defers on it — but
     * not the reverse, because nothing here is acquired or held across the two calls. Asymmetric in
     * time is fine and expected; a caller "fixing" this into a symmetric reservation would be
     * reintroducing the lock card 0104 deliberately chose not to build.
     */
    it('defers only from the side without the live claim, not symmetrically', async () => {
        await board.create(
            card('0001', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );
        await board.create(
            card('0002', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );
        await claimCard(config.project, '0001');

        const conflict = await board.scopeConflict(events, config.project, await board.read('0002'), stages);
        expect(conflict?.cardId).toBe('0001');

        expect(await board.scopeConflict(events, config.project, await board.read('0001'), stages)).toBeUndefined();
    });

    it('does not defer against a card sitting in parking-lot or a terminal stage', async () => {
        await board.create(
            card('0001', { stage: 'parking-lot' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );
        await board.create(
            card('0002', { stage: 'merged' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );
        await board.create(
            card('0003', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );

        expect(await board.scopeConflict(events, config.project, await board.read('0003'), stages)).toBeUndefined();
    });

    it('does not defer against a card sitting in a manual (non-agent) stage', async () => {
        await board.create(
            card('0001', { stage: 'review' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );
        await board.create(
            card('0002', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );

        expect(await board.scopeConflict(events, config.project, await board.read('0002'), stages)).toBeUndefined();
    });

    // Acceptance criteria (card 0104): "Overlap with a card in ready, backlog or a terminal stage
    // does not defer." Neither `ready` nor `backlog` appears in this describe's own stage config
    // (they precede the agent stages entirely), so `isRunningStage` reaches `findStage`'s `catch` —
    // an unrecognised stage counts as holding nothing, the same conclusion `parking-lot` reaches
    // through its own explicit branch.
    it('does not defer against a card sitting in ready or backlog', async () => {
        await board.create(
            card('0001', { stage: 'ready' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );
        await board.create(
            card('0002', { stage: 'backlog' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );
        await board.create(
            card('0003', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/modules/events/card.event.ts\n'),
            'create',
        );

        expect(await board.scopeConflict(events, config.project, await board.read('0003'), stages)).toBeUndefined();
    });

    // The 0090/0100 incident: two cards colliding entirely through a path neither plan named,
    // acquired mid-run via `request_scope` and recorded as a `scope.granted` event.
    it('defers when the collision exists only through a scope.granted path, not a declared one', async () => {
        await board.create(card('0001', { stage: 'implementing' }), 'create');
        await board.create(card('0002', { stage: 'implementing' }), 'create');

        await events.append({
            project: config.project,
            cardId: '0001',
            stage: 'implementing',
            type: 'scope.granted',
            payload: { path: 'apps/api/src/board-view.ts', reason: 'needed it' },
        });
        await events.append({
            project: config.project,
            cardId: '0002',
            stage: 'implementing',
            type: 'scope.granted',
            payload: { path: 'apps/api/src/board-view.ts', reason: 'needed it too' },
        });
        await claimCard(config.project, '0001');

        const conflict = await board.scopeConflict(events, config.project, await board.read('0002'), stages);

        expect(conflict?.cardId).toBe('0001');
        expect(conflict?.overlap).toEqual([{ ours: 'apps/api/src/board-view.ts', theirs: 'apps/api/src/board-view.ts' }]);
    });

    // `patternsOverlap` (scope.overlap.ts), reused rather than reimplemented — a directory glob
    // overlaps a specific file beneath it even though the glob never spells the file out.
    it('defers on a glob overlapping a literal path beneath it, via the shared patternsOverlap matcher', async () => {
        await board.create(
            card('0001', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/generated/**\n'),
            'create',
        );
        await board.create(
            card('0002', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/generated/types.ts\n'),
            'create',
        );
        await claimCard(config.project, '0001');

        const conflict = await board.scopeConflict(events, config.project, await board.read('0002'), stages);

        expect(conflict?.cardId).toBe('0001');
    });

    it('does not defer when the two scopes are entirely disjoint', async () => {
        await board.create(card('0001', { stage: 'implementing' }, '## Files in scope\n\n- apps/web/src/a.ts\n'), 'create');
        await board.create(card('0002', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/b.ts\n'), 'create');

        expect(await board.scopeConflict(events, config.project, await board.read('0002'), stages)).toBeUndefined();
    });
});
