import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { EncryptionProvider } from '@maroonedsoftware/encryption';
import type { DB } from '#modules/data/db.js';
import { SecretRepository } from '#modules/secrets/secret.repository.js';
import { REDACTED, SecretsService } from '#modules/secrets/secrets.service.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/** Against a real connection, as `engine.tokens.service.test.ts` is. Names are unique: the table is deployment-scoped. */
let db: Kysely<DB>;
let secrets: SecretsService;

const uniqueName = (): string => uniqueProject().toLowerCase();

beforeAll(() => {
    db = testDb();
    secrets = new SecretsService(new SecretRepository(db), new EncryptionProvider(randomBytes(32)));
});
afterAll(async () => {
    await db.destroy();
});

describe('SecretsService', () => {
    it('keeps only ciphertext and hands the value back only through resolve', async () => {
        const name = uniqueName();

        const saved = await secrets.put(name, { value: '  hunter2-value\n' });

        const row = await db.selectFrom('wilson.secrets').select('ciphertext').where('name', '=', name).executeTakeFirstOrThrow();
        expect(row.ciphertext).not.toContain('hunter2');
        expect(JSON.stringify(saved)).not.toContain('hunter2');
        expect(JSON.stringify(await secrets.list())).not.toContain('hunter2');
        await expect(secrets.resolve(name)).resolves.toBe('hunter2-value');
    });

    it('replaces a value saved under the same name', async () => {
        const name = uniqueName();

        await secrets.put(name, { value: 'first' });
        await secrets.put(name, { value: 'second' });

        await expect(secrets.resolve(name)).resolves.toBe('second');
    });

    it('refuses a bad name and an empty value', async () => {
        await expect(secrets.put('Not A Name', { value: 'x' })).rejects.toMatchObject({ details: { reason: expect.stringContaining('name') } });
        await expect(secrets.put(uniqueName(), { value: ' \n' })).rejects.toMatchObject({ details: { reason: 'a secret cannot be empty' } });
    });

    it('forgets a secret, and refuses one that was never saved', async () => {
        const name = uniqueName();
        await secrets.put(name, { value: 'x' });

        await secrets.remove(name);

        await expect(secrets.resolve(name)).resolves.toBeUndefined();
        await expect(secrets.remove(name)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('refuses to forget a secret a connection uses, and says which', async () => {
        const [name, connection] = [uniqueName(), uniqueName()];
        await secrets.put(name, { value: 'x' });
        await db.insertInto('wilson.mcpConnections').values({ name: connection, url: 'http://localhost/mcp', secret: name }).execute();

        expect((await secrets.list()).find(secret => secret.name === name)?.connections).toEqual([connection]);
        await expect(secrets.remove(name)).rejects.toMatchObject({ statusCode: 409, details: { reason: expect.stringContaining(connection) } });

        await db.deleteFrom('wilson.mcpConnections').where('name', '=', connection).execute();
        await secrets.remove(name);
    });

    it('says so when a value will not decrypt, rather than answering nothing', async () => {
        const name = uniqueName();
        await new SecretsService(new SecretRepository(db), new EncryptionProvider(randomBytes(32))).put(name, { value: 'x' });

        await expect(secrets.resolve(name)).rejects.toThrow('cannot be decrypted');
        await db.deleteFrom('wilson.secrets').where('name', '=', name).execute();
    });

    it('redacts every saved value from text, and passes over a row it cannot decrypt', async () => {
        const [first, second, foreign] = [uniqueName(), uniqueName(), uniqueName()];
        const value = randomBytes(8).toString('hex');
        await secrets.put(first, { value });
        await secrets.put(second, { value: `${value}-other` });
        await new SecretsService(new SecretRepository(db), new EncryptionProvider(randomBytes(32))).put(foreign, { value: 'x' });

        const redacted = (await secrets.redactor())(`token=${value} and ${value}-other`);

        expect(redacted).toBe(`token=${REDACTED} and ${REDACTED}`);
        await db.deleteFrom('wilson.secrets').where('name', 'in', [first, second, foreign]).execute();
    });
});
