import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { ChatMessageRepository } from '#modules/chat/chat.message.repository.js';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import type { DB } from '#modules/data/db.js';
import { testDb } from '#tests/support/test.db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/**
 * Threads are not project-scoped, so `uniqueProject()` cannot isolate them the way it isolates
 * cards: every test file sees every thread. These assert only on the threads each test made itself,
 * and on their order relative to one another.
 */
describe('ChatThreadRepository', () => {
    const threads = () => new ChatThreadRepository(db);
    const ids = (list: { id: string }[], mine: string[]) => list.map(thread => thread.id).filter(id => mine.includes(id));

    it('creates a thread on the engine it is given, with nothing archived and no session yet', async () => {
        const thread = await threads().create('first question', 'cli');

        expect(thread).toMatchObject({ title: 'first question', engine: 'cli', engineSessionId: undefined, archivedAt: undefined });
        expect(await threads().get(thread.id)).toEqual(thread);
    });

    it('refuses an engine the schema does not know', async () => {
        await expect(threads().create('x', 'other' as never)).rejects.toThrow();
    });

    it('answers undefined for a thread that does not exist', async () => {
        expect(await threads().get('999999999')).toBeUndefined();
        expect(await threads().rename('999999999', 'x')).toBeUndefined();
        expect(await threads().archive('999999999')).toBeUndefined();
    });

    it('lists the most recently active thread first, where a new message counts as activity', async () => {
        const older = await threads().create('older', 'api');
        const newer = await threads().create('newer', 'api');
        expect(ids(await threads().list(), [older.id, newer.id])).toEqual([newer.id, older.id]);

        await new ChatMessageRepository(db).append(older.id, { role: 'user', content: 'back to this one' });

        expect(ids(await threads().list(), [older.id, newer.id])).toEqual([older.id, newer.id]);
    });

    it('renames a thread', async () => {
        const thread = await threads().create('untitled', 'api');

        expect(await threads().rename(thread.id, 'board triage')).toMatchObject({ id: thread.id, title: 'board triage' });
    });

    it('takes an archived thread out of the list without deleting it', async () => {
        const thread = await threads().create('done with this', 'api');

        const archived = await threads().archive(thread.id);

        expect(archived?.archivedAt).toBeDefined();
        expect(ids(await threads().list(), [thread.id])).toEqual([]);
        expect(await threads().get(thread.id)).toMatchObject({ id: thread.id, title: 'done with this' });
    });

    it("records the 'cli' engine's session id for the next turn to resume", async () => {
        const thread = await threads().create('resumable', 'cli');

        await threads().setEngineSessionId(thread.id, 'session-123');

        expect((await threads().get(thread.id))?.engineSessionId).toBe('session-123');
    });
});
