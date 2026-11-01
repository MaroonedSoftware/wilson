import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { HostRepository } from '#modules/host/host.repository.js';
import { HostsService } from '#modules/host/hosts.service.js';
import { hashWorkerToken, WORKER_TOKEN_PREFIX } from '#modules/host/worker.token.js';
import { WorkerTokensService } from '#modules/host/worker.tokens.service.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/** Against a real connection, as `hosts.service.test.ts` is, so the hash lookup and constraints are Postgres's. */
let db: Kysely<DB>;
let hosts: HostsService;
let tokens: WorkerTokensService;

beforeAll(() => {
    db = testDb();
    const repository = new HostRepository(db);
    hosts = new HostsService(repository, new ProjectRepository(db));
    tokens = new WorkerTokensService(repository);
});
afterAll(async () => {
    await db.destroy();
});

const registerWorker = async (): Promise<string> => {
    const name = uniqueProject();
    await hosts.create({ name, kind: 'worker' });
    return name;
};

describe('WorkerTokensService', () => {
    it('mints a token that authenticates as its host, keeping only its hash and hint', async () => {
        const name = await registerWorker();

        const issued = await tokens.issue(name);

        expect(issued.token.startsWith(WORKER_TOKEN_PREFIX)).toBe(true);
        expect(issued.host.workerToken).toMatchObject({ hint: issued.token.slice(-4) });
        expect((await tokens.authenticate(issued.token))?.name).toBe(name);

        const row = await db.selectFrom('wilson.hosts').select(['workerTokenHash']).where('name', '=', name).executeTakeFirstOrThrow();
        expect(row.workerTokenHash).toBe(hashWorkerToken(issued.token));
        expect(JSON.stringify(await hosts.get(name))).not.toContain(issued.token);
    });

    it('replaces the last token when another is minted, so the old one stops working', async () => {
        const name = await registerWorker();
        const first = await tokens.issue(name);

        const second = await tokens.issue(name);

        expect(await tokens.authenticate(first.token)).toBeUndefined();
        expect((await tokens.authenticate(second.token))?.name).toBe(name);
    });

    it('stops authenticating once revoked, and for a disabled host', async () => {
        const revoked = await registerWorker();
        const revokedToken = (await tokens.issue(revoked)).token;
        await tokens.revoke(revoked);
        expect(await tokens.authenticate(revokedToken)).toBeUndefined();
        expect((await hosts.get(revoked)).workerToken).toBeUndefined();

        const disabled = await registerWorker();
        const disabledToken = (await tokens.issue(disabled)).token;
        await hosts.update(disabled, { enabled: false });
        expect(await tokens.authenticate(disabledToken)).toBeUndefined();
    });

    it('authenticates nothing for a token it never minted, or one without the prefix', async () => {
        expect(await tokens.authenticate(`${WORKER_TOKEN_PREFIX}not-a-real-token`)).toBeUndefined();
        expect(await tokens.authenticate('')).toBeUndefined();
        expect(await tokens.authenticate('wilson_key_something')).toBeUndefined();
    });

    it('refuses an SSH host with 400 and an unknown one with 404', async () => {
        const ssh = uniqueProject();
        await hosts.create({ name: ssh });

        await expect(tokens.issue(ssh)).rejects.toMatchObject({ statusCode: 400 });
        await expect(tokens.revoke(ssh)).rejects.toMatchObject({ statusCode: 400 });
        await expect(tokens.issue(uniqueProject())).rejects.toMatchObject({ statusCode: 404 });
    });

    it('keeps a worker token off an SSH host in the table itself', async () => {
        const ssh = uniqueProject();
        await hosts.create({ name: ssh });

        await expect(
            db
                .updateTable('wilson.hosts')
                .set({ workerTokenHash: 'x', workerTokenHint: 'x', workerTokenIssuedAt: DateTime.now() })
                .where('name', '=', ssh)
                .execute(),
        ).rejects.toThrow();
    });
});
