import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import { ChatAttachmentService, MAX_CHAT_IMAGE_BYTES } from '#modules/chat/chat.attachment.service.js';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, startTestServer, type TestServer } from '#tests/support/test.server.js';

/** Chat images over real HTTP (`startTestServer`), through the real multipart parser. */
let server: TestServer;
let release: () => Promise<void>;
let accessToken: string;
let threadId: string;

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (size: number): Buffer => Buffer.concat([PNG_HEADER, Buffer.alloc(size - PNG_HEADER.length, 1)]);

const form = (bytes: Buffer, type = 'image/png', name = 'shot.png'): FormData => {
    const body = new FormData();
    body.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
    return body;
};

const auth = (token: string | undefined = accessToken) => (token === undefined ? {} : { authorization: `Bearer ${token}` });
const newThread = async () => (await server.container.get(ChatThreadRepository).create('a thread', 'api')).id;
const upload = (body: FormData, thread = threadId) =>
    fetch(`${server.base}/api/chat/threads/${thread}/attachments`, { method: 'POST', body, headers: auth() });
const fetchImage = (attachmentId: string, thread = threadId) =>
    fetch(`${server.base}/api/chat/threads/${thread}/attachments/${attachmentId}`, { headers: auth() });
const reasonOf = async (response: Response): Promise<string> => ((await response.json()) as { details: { reason: string } }).details.reason;

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
    threadId = await newThread();
});

describe('chat images', () => {
    it('takes an image, then serves it back under its sniffed type with the fixed headers', async () => {
        const bytes = png(2048);

        const added = await upload(form(bytes, 'image/png', '../../my shot.png'));
        expect(added.status).toBe(200);
        const attachment = (await added.json()) as { id: string; filename: string; contentType: string; byteSize: number };
        expect(attachment).toMatchObject({ filename: 'my-shot.png', contentType: 'image/png', byteSize: 2048 });

        const fetched = await fetchImage(attachment.id);
        expect(fetched.status).toBe(200);
        expect(fetched.headers.get('content-type')).toBe('image/png');
        expect(fetched.headers.get('x-content-type-options')).toBe('nosniff');
        expect(fetched.headers.get('content-security-policy')).toBe("default-src 'none'");
        expect(Buffer.from(await fetched.arrayBuffer())).toEqual(bytes);
    });

    it('misses an image from another thread, an id no row could have, and a thread that does not exist', async () => {
        const added = await upload(form(png(64)));
        const { id } = (await added.json()) as { id: string };

        expect((await fetchImage(id, await newThread())).status).toBe(404);
        expect((await fetchImage('not-an-id')).status).toBe(404);
        expect((await fetchImage(id, '999999999')).status).toBe(404);
        expect((await upload(form(png(64)), '999999999')).status).toBe(404);
    });

    it('refuses bytes that are not an image, and bytes that disagree with their declared type', async () => {
        const text = await upload(form(Buffer.from('<svg></svg>'), 'image/svg+xml', 'a.svg'));
        expect(text.status).toBe(400);
        expect(await reasonOf(text)).toMatch(/not a PNG, JPEG, WebP or GIF/);

        const lying = await upload(form(png(64), 'image/jpeg', 'a.jpg'));
        expect(lying.status).toBe(400);
        expect(await reasonOf(lying)).toMatch(/declared image\/jpeg/);
    });

    it('serves a created SVG as image/svg+xml with the fixed headers', async () => {
        const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4" fill="teal"/></svg>';
        const created = await server.container.get(ChatAttachmentService).create(threadId, { kind: 'svg', source }, 'chart.svg');

        const fetched = await fetchImage(created.id);
        expect(fetched.status).toBe(200);
        expect(fetched.headers.get('content-type')).toBe('image/svg+xml');
        expect(fetched.headers.get('x-content-type-options')).toBe('nosniff');
        expect(fetched.headers.get('content-security-policy')).toBe("default-src 'none'");
        expect(await fetched.text()).toBe(source);
    });

    it('still refuses a valid SVG uploaded as a file, whatever it is declared as', async () => {
        const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
        for (const type of ['image/svg+xml', 'image/png']) {
            const refused = await upload(form(source, type, 'a.svg'));
            expect(refused.status).toBe(400);
            expect(await reasonOf(refused)).toMatch(/not a PNG, JPEG, WebP or GIF/);
        }
        expect(await server.db.selectFrom('wilson.chatAttachments').select('id').where('threadId', '=', BigInt(threadId)).execute()).toEqual([]);
    });

    it('refuses an image past the cap with 413', async () => {
        const over = await upload(form(png(MAX_CHAT_IMAGE_BYTES + 1)));
        expect(over.status).toBe(413);
        expect(await server.db.selectFrom('wilson.chatAttachments').select('id').where('threadId', '=', BigInt(threadId)).execute()).toEqual([]);
    });

    it('needs a credential', async () => {
        const anonymous = await fetch(`${server.base}/api/chat/threads/${threadId}/attachments/1`);
        expect(anonymous.status).toBe(401);
    });
});
