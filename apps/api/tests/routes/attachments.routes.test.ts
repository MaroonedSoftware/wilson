import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BoardRepository } from '#modules/board/board.repository.js';
import type { Card } from '#modules/board/card.js';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, request, startTestServer, type TestServer } from '#tests/support/test.server.js';

/** Image attachments over real HTTP (`startTestServer`), through the real multipart parser. */
let server: TestServer;
let release: () => Promise<void>;
let accessToken: string;
let cardId: string;

const MB = 1024 * 1024;
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (size: number): Buffer => Buffer.concat([PNG_HEADER, Buffer.alloc(size - PNG_HEADER.length, 1)]);

const form = (...files: { bytes: Buffer; type?: string; name?: string }[]): FormData => {
    const body = new FormData();
    for (const { bytes, type = 'image/png', name = 'shot.png' } of files) body.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
    return body;
};

const upload = (body: FormData, token: string | undefined = accessToken) =>
    fetch(`${server.base}/api/cards/${cardId}/attachments`, {
        method: 'POST',
        body,
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });

const rowCount = async (): Promise<number> =>
    (await server.db.selectFrom('wilson.cardAttachments').select('id').where('cardId', '=', cardId).execute()).length;

beforeAll(async () => {
    release = await holdAccounts();
    server = await startTestServer();
});
afterAll(async () => {
    await clearAccounts(server.db);
    await server.stop();
    await release();
});
beforeEach(async () => {
    await clearAccounts(server.db);
    ({ accessToken } = await onboardAndSignIn(server));
    cardId = `att-${randomUUID().slice(0, 8)}`;
    const card: Card = {
        frontmatter: { id: cardId, title: 'attachments', stage: 'planning', dependsOn: [], retries: {} },
        sections: {},
        body: 'body',
    };
    await server.container.get(BoardRepository).create(card, 'seed');
});

describe('card attachments', () => {
    it('takes a 1.2 MB PNG past the JSON limit, then lists, fetches and removes it', async () => {
        const bytes = png(1.2 * MB);

        const added = await upload(form({ bytes, name: '../../my shot.png' }));
        expect(added.status).toBe(200);
        const attachment = (await added.json()) as {
            id: string;
            filename: string;
            contentType: string;
            byteSize: number;
            contentHash: string;
            addedBy: string;
        };
        expect(attachment).toMatchObject({ filename: 'my-shot.png', contentType: 'image/png', byteSize: bytes.length, addedBy: 'human' });
        expect(attachment.contentHash).toMatch(/^[0-9a-f]{64}$/);

        const listed = await request(server, 'GET', `/api/cards/${cardId}/attachments`, { token: accessToken });
        expect(listed.status).toBe(200);
        const rows = (await listed.json()) as Record<string, unknown>[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).not.toHaveProperty('bytes');

        const fetched = await request(server, 'GET', `/api/cards/${cardId}/attachments/${attachment.id}`, { token: accessToken });
        expect(fetched.status).toBe(200);
        expect(fetched.headers.get('content-type')).toBe('image/png');
        expect(fetched.headers.get('x-content-type-options')).toBe('nosniff');
        expect(fetched.headers.get('content-security-policy')).toBe("default-src 'none'");
        expect(Buffer.compare(Buffer.from(await fetched.arrayBuffer()), bytes)).toBe(0);

        const removed = await request(server, 'DELETE', `/api/cards/${cardId}/attachments/${attachment.id}`, { token: accessToken });
        expect(removed.status).toBe(204);
        expect(await rowCount()).toBe(0);
        expect((await request(server, 'GET', `/api/cards/${cardId}/attachments/${attachment.id}`, { token: accessToken })).status).toBe(404);
    });

    it('records adding and removing in the card event log', async () => {
        const { id } = (await (await upload(form({ bytes: png(64) }))).json()) as { id: string };
        await request(server, 'DELETE', `/api/cards/${cardId}/attachments/${id}`, { token: accessToken });

        const events = await server.db
            .selectFrom('wilson.cardEvents')
            .select('type')
            .where('cardId', '=', cardId)
            .where('type', 'like', 'attachment.%')
            .orderBy('id')
            .execute();
        expect(events.map(event => event.type)).toEqual(['attachment.added', 'attachment.removed']);
    });

    it('accepts exactly 5 MB and answers 413 for one byte more, leaving no row', async () => {
        expect((await upload(form({ bytes: png(5 * MB) }))).status).toBe(200);
        expect(await rowCount()).toBe(1);

        expect((await upload(form({ bytes: png(5 * MB + 1) }))).status).toBe(413);
        expect(await rowCount()).toBe(1);
    });

    it('answers 413 for two files, leaving no row', async () => {
        expect((await upload(form({ bytes: png(64) }, { bytes: png(64), name: 'b.png' }))).status).toBe(413);
        expect(await rowCount()).toBe(0);
    });

    it('answers 400 with a reason for a request with no file part', async () => {
        const body = new FormData();
        body.append('note', 'no file here');

        const res = await upload(body);

        expect(res.status).toBe(400);
        expect(((await res.json()) as { details: { reason: string } }).details.reason).toMatch(/no file part/);
    });

    it('answers 400 for a spoofed declared type', async () => {
        expect((await upload(form({ bytes: png(64), type: 'image/jpeg' }))).status).toBe(400);
        expect(await rowCount()).toBe(0);
    });

    it('answers 415 for a body that is not multipart', async () => {
        const res = await fetch(`${server.base}/api/cards/${cardId}/attachments`, {
            method: 'POST',
            headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'text/plain' },
            body: 'not a form',
        });

        expect(res.status).toBe(415);
    });

    it('answers 404 for an unknown card and an id that is not an id', async () => {
        expect((await request(server, 'GET', '/api/cards/no-such-card/attachments', { token: accessToken })).status).toBe(404);
        expect((await request(server, 'GET', `/api/cards/${cardId}/attachments/abc`, { token: accessToken })).status).toBe(404);
        expect((await request(server, 'DELETE', `/api/cards/${cardId}/attachments/abc`, { token: accessToken })).status).toBe(404);
    });

    it('lets a view key list and fetch but not upload or remove', async () => {
        const { id } = (await (await upload(form({ bytes: png(64) }))).json()) as { id: string };
        const created = await request(server, 'POST', '/api/auth/keys', { token: accessToken, body: { name: 'read-only', scope: 'view' } });
        const { token } = (await created.json()) as { token: string };

        expect((await request(server, 'GET', `/api/cards/${cardId}/attachments`, { token })).status).toBe(200);
        expect((await request(server, 'GET', `/api/cards/${cardId}/attachments/${id}`, { token })).status).toBe(200);
        const refusedUpload = await upload(form({ bytes: png(64) }), token);
        expect(refusedUpload.status).toBe(403);
        expect(refusedUpload.headers.get('www-authenticate')).toContain('insufficient_scope');
        expect((await request(server, 'DELETE', `/api/cards/${cardId}/attachments/${id}`, { token })).status).toBe(403);
        expect(await rowCount()).toBe(1);
    });

    it('answers 401 on all four routes with no credential', async () => {
        const path = `/api/cards/${cardId}/attachments`;

        expect((await request(server, 'GET', path)).status).toBe(401);
        expect((await request(server, 'GET', `${path}/1`)).status).toBe(401);
        expect((await request(server, 'DELETE', `${path}/1`)).status).toBe(401);
        const body = form({ bytes: png(64) });
        expect((await fetch(`${server.base}${path}`, { method: 'POST', body })).status).toBe(401);
    });
});
