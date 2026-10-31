import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { EncryptionProvider } from '@maroonedsoftware/encryption';
import type { DB } from '#modules/data/db.js';
import { EngineTokenRepository } from '#modules/host/engine.token.repository.js';
import { EngineTokensService } from '#modules/host/engine.tokens.service.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/** Against a real connection, as `worker.tokens.service.test.ts` is. Names are unique: the table is deployment-scoped. */
let db: Kysely<DB>;
let tokens: EngineTokensService;
const key = randomBytes(32);

const uniqueName = (): string => uniqueProject().toLowerCase();

beforeAll(() => {
    db = testDb();
    tokens = new EngineTokensService(new EngineTokenRepository(db), new EncryptionProvider(key));
});
afterAll(async () => {
    await db.destroy();
});

describe('EngineTokensService', () => {
    it('keeps only ciphertext and hands the token back only through resolve', async () => {
        const name = uniqueName();

        const saved = await tokens.put(name, { token: '  sk-ant-oat01-secret\n' });

        const row = await db.selectFrom('wilson.engineTokens').select('ciphertext').where('name', '=', name).executeTakeFirstOrThrow();
        expect(row.ciphertext).not.toContain('sk-ant-oat01-secret');
        expect(JSON.stringify(saved)).not.toContain('secret');
        expect(JSON.stringify(await tokens.list())).not.toContain('secret');
        await expect(tokens.resolve(name)).resolves.toBe('sk-ant-oat01-secret');
    });

    it('replaces one token and leaves the others as they were', async () => {
        const [first, second] = [uniqueName(), uniqueName()];
        await tokens.put(first, { token: 'first-old' });
        await tokens.put(second, { token: 'second' });
        const before = await db.selectFrom('wilson.engineTokens').selectAll().where('name', '=', second).executeTakeFirstOrThrow();

        await tokens.put(first, { token: 'first-new' });

        await expect(tokens.resolve(first)).resolves.toBe('first-new');
        expect(await db.selectFrom('wilson.engineTokens').selectAll().where('name', '=', second).executeTakeFirstOrThrow()).toEqual(before);
    });

    it('removes one token and leaves the others', async () => {
        const [first, second] = [uniqueName(), uniqueName()];
        await tokens.put(first, { token: 'first' });
        await tokens.put(second, { token: 'second' });

        await tokens.remove(first);

        await expect(tokens.resolve(first)).resolves.toBeUndefined();
        await expect(tokens.resolve(second)).resolves.toBe('second');
    });

    it('refuses a bad name or token with 400, and removing an unknown name with 404', async () => {
        await expect(tokens.put('Has Spaces', { token: 'fine' })).rejects.toMatchObject({ statusCode: 400 });
        await expect(tokens.put(uniqueName(), { token: 'two words' })).rejects.toMatchObject({ statusCode: 400 });
        await expect(tokens.put(uniqueName(), { token: '   ' })).rejects.toMatchObject({ statusCode: 400 });
        await expect(tokens.remove(uniqueName())).rejects.toMatchObject({ statusCode: 404 });
    });

    it('says so when a row will not decrypt, without saying what it held', async () => {
        const name = uniqueName();
        await tokens.put(name, { token: 'unreadable' });
        const rekeyed = new EngineTokensService(new EngineTokenRepository(db), new EncryptionProvider(randomBytes(32)));

        await expect(rekeyed.resolve(name)).rejects.toThrow(`The engine token "${name}" cannot be decrypted`);
    });
});
