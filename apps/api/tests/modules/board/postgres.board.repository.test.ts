import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresBoardRepository, CardNotFoundError } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

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
        config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
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
});
