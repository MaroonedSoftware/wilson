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

    describe('applySplit', () => {
        const write = (origin: Card) => ({
            // The first piece depends on the second, which does not exist until the same transaction.
            pieces: [
                { card: card('0002', { splitFrom: '0001', dependsOn: ['0003'] }), message: 'Auto-split 0001 into 0002' },
                { card: card('0003', { splitFrom: '0001' }), message: 'Auto-split 0001 into 0003' },
            ],
            origin: { ...origin, frontmatter: { ...origin.frontmatter, stage: 'split' } },
            originMessage: 'Auto-split 0001 into 0002, 0003',
            events: [],
        });

        it('creates the pieces with their dependencies and versions, and rewrites the origin', async () => {
            await board.create(card('0001', { stage: 'scope-check' }), 'create');

            await board.applySplit('0001', write);

            expect((await board.read('0001')).frontmatter.stage).toBe('split');
            expect((await board.read('0002')).frontmatter.dependsOn).toEqual(['0003']);
            expect((await board.versions('0002', 5)).map(v => v.message)).toEqual(['Auto-split 0001 into 0002']);
            expect((await board.versions('0001', 1))[0]?.message).toBe('Auto-split 0001 into 0002, 0003');
        });

        it('hands the plan the board as it stands, and writes nothing when the plan declines', async () => {
            await board.create(card('0001'), 'create');
            await board.create(card('0002'), 'create');
            let seen: string[] = [];

            const result = await board.applySplit('0001', (_origin, cards) => {
                seen = cards.map(c => c.frontmatter.id);
                return undefined;
            });

            expect(result).toBeUndefined();
            expect(seen).toEqual(['0001', '0002']);
            expect((await board.versions('0001', 5))).toHaveLength(1);
        });

        it('leaves no piece behind when one of them cannot be created', async () => {
            await board.create(card('0001', { stage: 'scope-check' }), 'create');
            await board.create(card('0003'), 'create');

            await expect(board.applySplit('0001', write)).rejects.toThrow();

            expect((await board.list()).map(c => c.frontmatter.id)).toEqual(['0001', '0003']);
            expect((await board.read('0001')).frontmatter.stage).toBe('scope-check');
        });
    });

    it('reads back what it created, sections included', async () => {
        await board.create(card('0001', {}, '## Goal\n\nShip it.\n\n## Files in scope\n\n- src/a.ts\n'), 'create');

        const stored = await board.read('0001');
        expect(stored.frontmatter.title).toBe('card 0001');
        expect(stored.sections['Files in scope']).toBe('- src/a.ts');
    });

    it('reads back splitFrom through read, list and the version snapshot, and undefined when unset', async () => {
        await board.create(card('0001'), 'create');
        await board.create(card('0002', { splitFrom: '0001' }), 'create');

        expect((await board.read('0001')).frontmatter.splitFrom).toBeUndefined();
        expect((await board.read('0002')).frontmatter.splitFrom).toBe('0001');
        expect((await board.list()).find(c => c.frontmatter.id === '0002')!.frontmatter.splitFrom).toBe('0001');

        const version = await board.currentVersion('0002');
        expect((await board.readAt('0002', version!)).frontmatter.splitFrom).toBe('0001');
    });

    it('refuses a splitFrom naming a card that does not exist', async () => {
        await expect(board.create(card('0002', { splitFrom: '9999' }), 'create')).rejects.toThrow();
    });

    it('keeps splitFrom across a later write, even one whose mutate callback changes it', async () => {
        await board.create(card('0001'), 'create');
        await board.create(card('0002'), 'create');
        await board.create(card('0003', { splitFrom: '0001' }), 'create');

        await board.write('0003', 'try to move it', c => ({ ...c, frontmatter: { ...c.frontmatter, splitFrom: '0002' } }));

        expect((await board.read('0003')).frontmatter.splitFrom).toBe('0001');
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
     * `wilson.cardJobs` rather than through `CardJobs`, since `BoardRepository` has no dependency on
     * the jobs module. A row existing (however it got there) means true; nothing does, or nothing
     * any longer does, means false.
     */
    it('hasLiveClaim reports true only while a claim row exists for that card', async () => {
        await board.create(card('0001'), 'create');

        expect(await board.hasLiveClaim(config.project, '0001')).toBe(false);

        await db.insertInto('wilson.cardJobs').values({ project: config.project, cardId: '0001', jobId: 'job-1' }).execute();
        expect(await board.hasLiveClaim(config.project, '0001')).toBe(true);

        await db.deleteFrom('wilson.cardJobs').where('project', '=', config.project).where('cardId', '=', '0001').execute();
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
        db.insertInto('wilson.cardJobs').values({ project, cardId, jobId }).execute();

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

/**
 * Card 0242. The 2026-09-19 incident: card 0240 sat in `scope-check` — a readonly stage that reads
 * the plan and writes nothing — with a live claim, and that alone (under the pre-0242 rule of
 * `isRunningStage` + `hasLiveClaim`) deferred card 0241's `testing`, one stage from done, on a scope
 * neither card's tree yet contained anything of. `holdsFiles` is the fix: another card now counts
 * toward a conflict only once something of it is actually in the tree — its current stage writes
 * (`worktree: 'rw'`), or its branch already carries a `work.committed` event.
 */
describe('PostgresBoardRepository.scopeConflict — holdsFiles (card 0242)', () => {
    let board: PostgresBoardRepository;
    let config: StaticBoardConfig;
    let events: EventLog;
    let stages: ProjectStages;

    beforeEach(async () => {
        events = new EventLog(db, silentLogger);

        stages = parseStages(`
stages:
  - name: scope-check
    mode: agent
    worktree: readonly
    model: claude-opus
    instructions: check the plan
    onPass: implementing
    onFail: scope-check
  - name: implementing
    mode: agent
    worktree: rw
    model: claude-opus
    instructions: implement it
    onPass: review
    onFail: implementing
  - name: review
    mode: agent
    worktree: readonly
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: implementing
`);

        config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        board = new PostgresBoardRepository(config, db, events);
    });

    const claimCard = (project: string, cardId: string, jobId = `job-${cardId}`) =>
        db.insertInto('wilson.cardJobs').values({ project, cardId, jobId }).execute();

    // AC1, and the exact 0240/0241 shape: a readonly stage, claimed, with nothing committed yet.
    // Before card 0242, `isRunningStage` + `hasLiveClaim` alone were enough, and this would defer.
    it('does not defer against a card claimed in a readonly stage that has committed nothing yet (the 0240/0241 incident)', async () => {
        await board.create(card('0001', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/data/contracts/board.ck\n'), 'create');
        await board.create(card('0002', { stage: 'scope-check' }, '## Files in scope\n\n- apps/api/data/contracts/board.ck\n'), 'create');
        await claimCard(config.project, '0002');

        expect(await board.scopeConflict(events, config.project, await board.read('0001'), stages)).toBeUndefined();
    });

    // AC2: a card on its first `implementing` run has no `work.committed` event yet, but it is
    // writing to its own worktree right now (`worktree: 'rw'`) — dropping it would let a second
    // card write the same file concurrently, so it must still count.
    it('defers against a card claimed in an rw stage even before its first commit', async () => {
        await board.create(card('0001', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/x.ts\n'), 'create');
        await board.create(card('0002', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/x.ts\n'), 'create');
        await claimCard(config.project, '0002');

        const conflict = await board.scopeConflict(events, config.project, await board.read('0001'), stages);
        expect(conflict?.cardId).toBe('0002');
    });

    // AC3: a later readonly stage (`review`) still holds what an earlier stage committed — the
    // `hasCommitted` half of `holdsFiles`, read from the same `work.committed` event the dispatcher
    // writes on every passing commit (stage.dispatcher.ts).
    it('defers against a card claimed in a readonly stage once it has a work.committed event', async () => {
        await board.create(card('0001', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/x.ts\n'), 'create');
        await board.create(card('0002', { stage: 'review' }, '## Files in scope\n\n- apps/api/src/x.ts\n'), 'create');
        await events.append({
            project: config.project,
            cardId: '0002',
            stage: 'implementing',
            type: 'work.committed',
            payload: { sha: 'deadbeef', branch: 'card/0002' },
        });
        await claimCard(config.project, '0002');

        const conflict = await board.scopeConflict(events, config.project, await board.read('0001'), stages);
        expect(conflict?.cardId).toBe('0002');
    });

    // AC4: card 0128's filter still runs first — no live claim at all means `holdsFiles` is never
    // even asked, whatever the other card's stage or event history says.
    it('still ignores a card with no live claim, even with a work.committed event and an rw stage', async () => {
        await board.create(card('0001', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/x.ts\n'), 'create');
        await board.create(card('0002', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/x.ts\n'), 'create');
        await events.append({
            project: config.project,
            cardId: '0002',
            stage: 'implementing',
            type: 'work.committed',
            payload: { sha: 'deadbeef', branch: 'card/0002' },
        });

        expect(await board.scopeConflict(events, config.project, await board.read('0001'), stages)).toBeUndefined();
    });

    // AC5: a stage the config cannot resolve is treated as holding — the conservative direction.
    // Built as the race the `holdsFiles` doc comment describes: `isRunningStage` resolves the other
    // card's stage while the config still has it, and the config changes before `holdsFiles`'s own
    // `findStage` call runs — simulated by mutating a plain (unfrozen — `parseStages` deep-freezes
    // its result, so a fresh clone is used) stages object as a side effect of the very `events.tail`
    // read `cardHistory` makes in between the two `findStage` calls.
    it('treats a card whose stage the config stops knowing about mid-check as still holding its files', async () => {
        const raceStages: ProjectStages = JSON.parse(JSON.stringify(stages));

        await board.create(card('0001', { stage: 'implementing' }, '## Files in scope\n\n- apps/api/src/x.ts\n'), 'create');
        await board.create(card('0002', { stage: 'scope-check' }, '## Files in scope\n\n- apps/api/src/x.ts\n'), 'create');
        await claimCard(config.project, '0002');

        const vanishingEvents = {
            tail: async (project: string, cardId: string, limit: number) => {
                const rows = await events.tail(project, cardId, limit);
                // Right after reading 0002's history — the moment `scopeConflict` is about to ask
                // `holdsFiles` to resolve its stage a second time — the stage disappears from the
                // config it is about to be looked up against.
                if (cardId === '0002') {
                    raceStages.stages = raceStages.stages.filter(s => s.name !== 'scope-check');
                }
                return rows;
            },
        } as unknown as EventLog;

        const conflict = await board.scopeConflict(vanishingEvents, config.project, await board.read('0001'), raceStages);
        expect(conflict?.cardId).toBe('0002');
    });
});
