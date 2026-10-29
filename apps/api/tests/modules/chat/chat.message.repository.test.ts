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

describe('ChatMessageRepository', () => {
    const messages = () => new ChatMessageRepository(db);
    const newThread = async () => (await new ChatThreadRepository(db).create('a thread', 'api')).id;

    it('numbers messages from 1 per thread, independently of other threads', async () => {
        const thread = await newThread();
        const other = await newThread();

        const first = await messages().append(thread, { role: 'user', content: 'what is in review?' });
        const second = await messages().append(thread, { role: 'assistant', content: 'two cards' });
        const elsewhere = await messages().append(other, { role: 'user', content: 'unrelated' });
        const third = await messages().append(thread, { role: 'user', content: 'move 0007 back' });

        expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
        expect(elsewhere.seq).toBe(1);
    });

    it('gives concurrent appends to one thread distinct, gapless numbers', async () => {
        const thread = await newThread();

        const appended = await Promise.all(Array.from({ length: 8 }, (_, i) => messages().append(thread, { role: 'user', content: `message ${i}` })));

        expect(appended.map(message => message.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("keeps an answer's operations and the engine's own record of the turn", async () => {
        const thread = await newThread();
        const operations = [
            { name: 'list_cards', arguments: {}, project: 'wilson', ok: true },
            { name: 'get_card', arguments: { id: '0099' }, project: 'wilson', ok: false },
        ];
        const engineMessages = [{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'dispatch_readonly' }] }];

        await messages().append(thread, { role: 'assistant', content: 'one card, and 0099 does not exist', operations, engineMessages });

        const [stored] = await messages().since(thread);
        expect(stored).toMatchObject({ role: 'assistant', operations, engineMessages });
    });

    it("stores a person's message with no operations and no engine record", async () => {
        const thread = await newThread();

        const message = await messages().append(thread, { role: 'user', content: 'hello' });

        expect(message.operations).toEqual([]);
        expect(message.engineMessages).toBeUndefined();
    });

    it('reads every message after a seq, never the one at it, in order', async () => {
        const thread = await newThread();
        for (const content of ['one', 'two', 'three']) await messages().append(thread, { role: 'user', content });

        expect((await messages().since(thread)).map(message => message.content)).toEqual(['one', 'two', 'three']);
        expect((await messages().since(thread, 1)).map(message => message.content)).toEqual(['two', 'three']);
        expect(await messages().since(thread, 3)).toEqual([]);
    });

    it('refuses a message for a thread that does not exist', async () => {
        await expect(messages().append('999999999', { role: 'user', content: 'nowhere' })).rejects.toThrow();
    });
});
