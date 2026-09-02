import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { ContextService } from '#modules/context/context.service.js';
import { CardContextRepository } from '#modules/context/card.context.repository.js';
import { ContextProviderRegistry } from '#modules/context/context.provider.registry.js';
import type { ContextFetchResult, ContextProvider } from '#modules/context/context.provider.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { DB } from '#modules/data/db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const fakeEvents = { append: vi.fn(async () => {}) } as unknown as EventLog;

const card = (id: string): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'planning', dependsOn: [], retries: {} },
    sections: {},
    body: 'body text',
});

/** A `ContextProvider` fake: handles every URL and always answers with `result` — the registry and
 * the URL provider have their own tests (card 0186) proving dispatch and fetch behaviour, so these
 * tests only need a stub simple enough to prove `ContextService` translates what it gets back. */
const stubProvider = (result: ContextFetchResult): ContextProvider => ({
    canHandle: () => true,
    fetch: async () => result,
});

const FETCHED_AT = new Date('2026-09-01T12:00:00.000Z');

describe('ContextService', () => {
    let config: StaticBoardConfig;
    let board: PostgresBoardRepository;
    let contextRepository: CardContextRepository;

    beforeEach(async () => {
        config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        board = new PostgresBoardRepository(config, db, fakeEvents);
        contextRepository = new CardContextRepository(config, db);
        await board.create(card('0001'), 'seed');
    });

    const service = (result: ContextFetchResult): ContextService =>
        new ContextService(board, contextRepository, new ContextProviderRegistry([stubProvider(result)]));

    it('attaches a fetched snapshot, converting fetchedAt to a Luxon DateTime and passing contentHash through unchanged', async () => {
        const svc = service({ ok: true, title: 'A title', content: 'the content', contentHash: 'hash-1', fetchedAt: FETCHED_AT });

        const snapshot = await svc.attach('0001', { sourceUrl: 'https://example.com/doc' });

        expect(snapshot.sourceUrl).toBe('https://example.com/doc');
        expect(snapshot.title).toBe('A title');
        expect(snapshot.content).toBe('the content');
        expect(snapshot.contentHash).toBe('hash-1');
        expect(snapshot.fetchedBy).toBe('human');
        expect(snapshot.fetchedAt).toBeInstanceOf(DateTime);
        expect((snapshot.fetchedAt as DateTime).toMillis()).toBe(FETCHED_AT.getTime());

        // And the row actually landed in storage, not just the returned value.
        const [stored] = await contextRepository.list('0001');
        expect(stored).toMatchObject({ sourceUrl: 'https://example.com/doc', contentHash: 'hash-1' });
    });

    it('records fetchedBy as \'human\', never the provider\'s own identity', async () => {
        const svc = service({ ok: true, content: 'content', contentHash: 'hash-1', fetchedAt: FETCHED_AT });

        const snapshot = await svc.attach('0001', { sourceUrl: 'https://example.com/doc' });

        expect(snapshot.fetchedBy).toBe('human');
    });

    it('answers 400 with the registry\'s own reason when no provider handles the URL', async () => {
        const svc = new ContextService(board, contextRepository, new ContextProviderRegistry([]));

        await expect(svc.attach('0001', { sourceUrl: 'https://example.com/doc' })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining('https://example.com/doc') },
        });
        expect(await contextRepository.list('0001')).toEqual([]);
    });

    it.each([
        'refused: private address',
        'refused: server responded with a redirect, which is not followed',
        'timed out after 15000ms',
        'exceeds the 2000000-byte limit',
        '"https://example.com/doc" returned 404',
    ])('answers 400 with the provider\'s own reason for a refusal: %s', async reason => {
        const svc = service({ ok: false, reason });

        await expect(svc.attach('0001', { sourceUrl: 'https://example.com/doc' })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason },
        });
        expect(await contextRepository.list('0001')).toEqual([]);
    });

    it('answers 404 for attach, list and remove on a card that does not exist', async () => {
        const svc = service({ ok: true, content: 'content', contentHash: 'hash-1', fetchedAt: FETCHED_AT });

        await expect(svc.attach('no-such-card', { sourceUrl: 'https://example.com/doc' })).rejects.toMatchObject({ statusCode: 404 });
        await expect(svc.list('no-such-card')).rejects.toMatchObject({ statusCode: 404 });
        await expect(svc.remove('no-such-card', '1')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('lists a card\'s snapshots oldest first', async () => {
        const svc = service({ ok: true, content: 'content', contentHash: 'hash-1', fetchedAt: FETCHED_AT });

        const first = await svc.attach('0001', { sourceUrl: 'https://example.com/a' });
        const second = await svc.attach('0001', { sourceUrl: 'https://example.com/b' });

        const listed = await svc.list('0001');
        expect(listed.map(s => s.id)).toEqual([first.id, second.id]);
    });

    it('removes one snapshot, leaving the others, and 404s removing it again', async () => {
        const svc = service({ ok: true, content: 'content', contentHash: 'hash-1', fetchedAt: FETCHED_AT });

        const first = await svc.attach('0001', { sourceUrl: 'https://example.com/a' });
        const second = await svc.attach('0001', { sourceUrl: 'https://example.com/b' });

        await svc.remove('0001', first.id);

        expect((await svc.list('0001')).map(s => s.id)).toEqual([second.id]);
        await expect(svc.remove('0001', first.id)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('answers 404 removing a snapshot id that exists but belongs to a different card', async () => {
        await board.create(card('0002'), 'seed');
        const svc = service({ ok: true, content: 'content', contentHash: 'hash-1', fetchedAt: FETCHED_AT });

        const snapshot = await svc.attach('0001', { sourceUrl: 'https://example.com/a' });

        await expect(svc.remove('0002', snapshot.id)).rejects.toMatchObject({ statusCode: 404 });
        expect((await svc.list('0001')).map(s => s.id)).toEqual([snapshot.id]);
    });
});
