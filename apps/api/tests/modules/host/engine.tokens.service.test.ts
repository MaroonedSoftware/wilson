import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { EncryptionProvider } from '@maroonedsoftware/encryption';
import type { DB } from '#modules/data/db.js';
import { EngineLimitRepository } from '#modules/host/engine.limit.repository.js';
import { EngineTokenRepository } from '#modules/host/engine.token.repository.js';
import { EngineTokensService } from '#modules/host/engine.tokens.service.js';
import { HostRepository } from '#modules/host/host.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/** Against a real connection, as `worker.tokens.service.test.ts` is. Names are unique: the table is deployment-scoped. */
let db: Kysely<DB>;
let tokens: EngineTokensService;
let hosts: HostRepository;
const key = randomBytes(32);

const uniqueName = (): string => uniqueProject().toLowerCase();

beforeAll(() => {
    db = testDb();
    hosts = new HostRepository(db);
    tokens = new EngineTokensService(new EngineTokenRepository(db), new EncryptionProvider(key), hosts, new EngineLimitRepository(db));
});
afterAll(async () => {
    await db.destroy();
});

/**
 * Every run has its own key and the test database outlives a run, so a pooled token left by an earlier
 * one cannot be decrypted, and `pool` refuses rather than skip it.
 */
const clearPool = () => db.deleteFrom('wilson.engineTokens').where('pooled', '=', true).where('name', 'like', 'test-%').execute();

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

    it('saves a new token as an Anthropic subscription at priority 0 unless told otherwise', async () => {
        const [plain, key] = [uniqueName(), uniqueName()];

        expect(await tokens.put(plain, { token: 'plain' })).toMatchObject({ provider: 'anthropic', kind: 'subscription', priority: 0 });
        expect(await tokens.put(key, { token: 'key', provider: 'openai', kind: 'api_key', priority: 5 })).toMatchObject({
            provider: 'openai',
            kind: 'api_key',
            priority: 5,
        });
    });

    it('keeps what a replacement leaves out', async () => {
        const name = uniqueName();
        await tokens.put(name, { token: 'old', provider: 'openai', kind: 'api_key', priority: 5 });

        expect(await tokens.put(name, { token: 'new' })).toMatchObject({ provider: 'openai', kind: 'api_key', priority: 5 });
        expect(await tokens.put(name, { token: 'newer', priority: 1 })).toMatchObject({ provider: 'openai', kind: 'api_key', priority: 1 });
        await expect(tokens.resolve(name)).resolves.toBe('newer');
    });

    it('refuses a priority outside 0 to 1000 with 400', async () => {
        await expect(tokens.put(uniqueName(), { token: 'fine', priority: -1 })).rejects.toMatchObject({ statusCode: 400 });
        await expect(tokens.put(uniqueName(), { token: 'fine', priority: 1001 })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('updates what is recorded about a token, keeping the token and what it has hit', async () => {
        const name = uniqueName();
        await tokens.put(name, { token: 'kept' });
        await new EngineLimitRepository(db).record(name, 'five_hour', DateTime.now().plus({ hours: 1 }));

        expect(await tokens.update(name, { pooled: true, priority: 7 })).toMatchObject({ pooled: true, priority: 7, kind: 'subscription' });

        await expect(tokens.resolve(name)).resolves.toBe('kept');
        expect((await tokens.limitsInForce()).map(limit => limit.account)).toContain(name);
        await tokens.remove(name);
    });

    it('refuses to update an unknown token with 404, and a bad change with 400', async () => {
        const [host, name] = [uniqueName(), uniqueName()];
        await hosts.create({ name: host, kind: 'worker', slots: 1 });
        await tokens.put(name, { token: 'value' });
        await tokens.assign(host, { name });

        await expect(tokens.update(uniqueName(), { pooled: true })).rejects.toMatchObject({ statusCode: 404 });
        await expect(tokens.update(name, { priority: 1001 })).rejects.toMatchObject({ statusCode: 400 });
        await expect(tokens.update(name, { provider: 'openai' })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('offers only pooled Anthropic tokens, by priority and then name, each with what to set it as', async () => {
        await clearPool();
        const prefix = uniqueName();
        const named = (suffix: string) => `${prefix}-${suffix}`;
        await tokens.put(named('b'), { token: 'b', pooled: true, priority: 900 });
        await tokens.put(named('a'), { token: 'a', pooled: true, priority: 900 });
        await tokens.put(named('c'), { token: 'c', pooled: true, priority: 800 });
        await tokens.put(named('out'), { token: 'out', priority: 800 });
        await tokens.put(named('key'), { token: 'key', pooled: true, kind: 'api_key', priority: 1000 });
        await tokens.put(named('other'), { token: 'other', pooled: true, provider: 'openai', kind: 'api_key' });

        const pool = (await tokens.pool()).filter(account => account.name.startsWith(prefix));

        expect(pool).toEqual([
            { name: named('c'), token: 'c', variable: 'CLAUDE_CODE_OAUTH_TOKEN' },
            { name: named('a'), token: 'a', variable: 'CLAUDE_CODE_OAUTH_TOKEN' },
            { name: named('b'), token: 'b', variable: 'CLAUDE_CODE_OAUTH_TOKEN' },
            { name: named('key'), token: 'key', variable: 'ANTHROPIC_API_KEY' },
        ]);
        for (const suffix of ['a', 'b', 'c', 'out', 'key', 'other']) await tokens.remove(named(suffix));
    });

    it('forgets the limits of a token that is replaced or removed, and only that token', async () => {
        const limits = new EngineLimitRepository(db);
        const [first, second] = [uniqueName(), uniqueName()];
        await tokens.put(first, { token: 'first' });
        await tokens.put(second, { token: 'second' });
        const resets = DateTime.now().plus({ hours: 1 });
        await limits.record(first, 'five_hour', resets);
        await limits.record(second, 'five_hour', resets);
        const limited = async () => (await limits.active()).map(limit => limit.account);

        await tokens.put(first, { token: 'first-new' });
        expect(await limited()).not.toContain(first);
        expect(await limited()).toContain(second);

        await tokens.remove(second);
        expect(await limited()).not.toContain(second);
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
        const rekeyed = new EngineTokensService(
            new EngineTokenRepository(db),
            new EncryptionProvider(randomBytes(32)),
            hosts,
            new EngineLimitRepository(db),
        );

        await expect(rekeyed.resolve(name)).rejects.toThrow(`The engine token "${name}" cannot be decrypted`);
    });

    it('assigns a token to a worker host by name, and shows the name and never the value', async () => {
        const [host, name] = [uniqueName(), uniqueName()];
        await hosts.create({ name: host, kind: 'worker', slots: 1 });
        await tokens.put(name, { token: 'assigned-value' });

        const assigned = await tokens.assign(host, { name });

        expect(assigned.engineToken).toBe(name);
        expect(JSON.stringify(assigned)).not.toContain('assigned-value');
        expect((await tokens.list()).find(token => token.name === name)?.hosts).toEqual([host]);

        expect((await tokens.unassign(host)).engineToken).toBeUndefined();
        expect((await tokens.list()).find(token => token.name === name)?.hosts).toEqual([]);
    });

    it('reads back the token a host is assigned now, and none once it has none', async () => {
        const [host, first, second] = [uniqueName(), uniqueName(), uniqueName()];
        await hosts.create({ name: host, kind: 'worker', slots: 1 });
        await tokens.put(first, { token: 'first-value' });
        await tokens.put(second, { token: 'second-value' });

        await expect(tokens.forHost(host)).resolves.toBeUndefined();

        await tokens.assign(host, { name: first });
        await expect(tokens.forHost(host)).resolves.toMatchObject({ token: 'first-value' });

        await tokens.put(first, { token: 'first-rotated' });
        await expect(tokens.forHost(host)).resolves.toMatchObject({ token: 'first-rotated' });

        await tokens.assign(host, { name: second });
        await expect(tokens.forHost(host)).resolves.toMatchObject({ token: 'second-value' });

        await tokens.remove(second);
        await expect(tokens.forHost(host)).resolves.toBeUndefined();
    });

    it('refuses an ssh host with 400, and an unknown host or token with 404', async () => {
        const [ssh, worker, name] = [uniqueName(), uniqueName(), uniqueName()];
        await hosts.create({ name: ssh, kind: 'ssh', sshTarget: 'box', slots: 1 });
        await hosts.create({ name: worker, kind: 'worker', slots: 1 });
        await tokens.put(name, { token: 'value' });

        await expect(tokens.assign(ssh, { name })).rejects.toMatchObject({ statusCode: 400 });
        await expect(tokens.assign(uniqueName(), { name })).rejects.toMatchObject({ statusCode: 404 });
        await expect(tokens.assign(worker, { name: uniqueName() })).rejects.toMatchObject({ statusCode: 404 });
        await expect(tokens.unassign(uniqueName())).rejects.toMatchObject({ statusCode: 404 });
    });

    it('pools OpenAI keys apart from Anthropic tokens, with no variable to set', async () => {
        await clearPool();
        const prefix = uniqueName();
        await tokens.put(`${prefix}-claude`, { token: 'claude', pooled: true });
        await tokens.put(`${prefix}-b`, { token: 'b', pooled: true, provider: 'openai', kind: 'api_key', priority: 2 });
        await tokens.put(`${prefix}-a`, { token: 'a', pooled: true, provider: 'openai', kind: 'api_key', priority: 1 });

        const pool = (await tokens.pool('openai')).filter(account => account.name.startsWith(prefix));

        expect(pool).toEqual([
            { name: `${prefix}-a`, token: 'a' },
            { name: `${prefix}-b`, token: 'b' },
        ]);
        await clearPool();
    });

    it('refuses with 400 an OpenAI token that is not an API key', async () => {
        const name = uniqueName();

        await expect(tokens.put(name, { token: 'value', provider: 'openai' })).rejects.toMatchObject({ statusCode: 400 });
        await expect(tokens.put(name, { token: 'value', provider: 'openai', kind: 'subscription' })).rejects.toMatchObject({ statusCode: 400 });

        await tokens.put(name, { token: 'value', provider: 'openai', kind: 'api_key' });
        await expect(tokens.update(name, { kind: 'subscription' })).rejects.toMatchObject({ statusCode: 400 });
        await expect(tokens.put(name, { token: 'rotated' })).resolves.toMatchObject({ kind: 'api_key' });
    });

    it('refuses with 400 to assign a token a host engine cannot sign in with', async () => {
        const [host, other] = [uniqueName(), uniqueName()];
        await hosts.create({ name: host, kind: 'worker', slots: 1 });
        await tokens.put(other, { token: 'value', provider: 'openai', kind: 'api_key' });

        await expect(tokens.assign(host, { name: other })).rejects.toMatchObject({ statusCode: 400 });
        expect((await hosts.find(host))?.engineToken).toBeUndefined();
    });

    it('assigns an Anthropic API key, to be set as one', async () => {
        const [host, key] = [uniqueName(), uniqueName()];
        await hosts.create({ name: host, kind: 'worker', slots: 1 });
        await tokens.put(key, { token: 'sk-ant-api', kind: 'api_key' });

        await tokens.assign(host, { name: key });

        await expect(tokens.forHost(host)).resolves.toEqual({ name: key, token: 'sk-ant-api', variable: 'ANTHROPIC_API_KEY' });
    });

    it('refuses with 400 to turn an assigned token into one its host cannot use, keeping the saved one', async () => {
        const [host, name] = [uniqueName(), uniqueName()];
        await hosts.create({ name: host, kind: 'worker', slots: 1 });
        await tokens.put(name, { token: 'value' });
        await tokens.assign(host, { name });

        await expect(tokens.put(name, { token: 'other', provider: 'openai', kind: 'api_key' })).rejects.toMatchObject({ statusCode: 400 });
        await expect(tokens.forHost(host)).resolves.toMatchObject({ token: 'value' });

        expect(await tokens.put(name, { token: 'rotated', priority: 3 })).toMatchObject({ priority: 3, hosts: [host] });
    });

    it('removes a token that is still assigned, leaving its hosts with none', async () => {
        const [host, name] = [uniqueName(), uniqueName()];
        await hosts.create({ name: host, kind: 'worker', slots: 1 });
        await tokens.put(name, { token: 'value' });
        await tokens.assign(host, { name });

        await tokens.remove(name);

        expect((await hosts.find(host))?.engineToken).toBeUndefined();
    });

    it('has Postgres refuse a token on an ssh host, whatever reaches the table', async () => {
        const [ssh, name] = [uniqueName(), uniqueName()];
        await hosts.create({ name: ssh, kind: 'ssh', sshTarget: 'box', slots: 1 });
        await tokens.put(name, { token: 'value' });

        await expect(hosts.setEngineToken(ssh, name)).rejects.toThrow();
    });
});
