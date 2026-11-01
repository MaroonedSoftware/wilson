import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, request, startTestServer, type TestServer } from '#tests/support/test.server.js';

/**
 * An event stream is one request that never ends, so it has to be told when the credential it was
 * opened with stops working. Driven over real HTTP: the stream ending means the socket closed.
 */
let server: TestServer;
let release: () => Promise<void>;
let session: string;

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
    ({ accessToken: session } = await onboardAndSignIn(server));
});

const mintKey = async (scope: 'view' | 'manage') => {
    const res = await request(server, 'POST', '/api/auth/keys', { token: session, body: { name: `stream ${scope}`, scope } });
    return (await res.json()) as { token: string; key: { id: string } };
};

/** Open `/api/feed`, and report whether it ends within a moment of `whenEnded` being asked. */
const openFeed = async (token: string) => {
    const res = await request(server, 'GET', '/api/feed', { token });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const drained = (async () => {
        for (;;) if ((await reader.read()).done) return 'ended' as const;
    })().catch(() => 'ended' as const);
    return {
        endsSoon: () => Promise.race([drained, new Promise<'open'>(resolve => setTimeout(() => resolve('open'), 500))]),
        cancel: () => reader.cancel().catch(() => undefined),
    };
};

describe('an open event stream', () => {
    it('ends when its session signs out', async () => {
        const feed = await openFeed(session);

        await request(server, 'POST', '/api/auth/logout', { token: session });

        expect(await feed.endsSoon()).toBe('ended');
    });

    it('ends when its API key is revoked', async () => {
        const { token, key } = await mintKey('view');
        const feed = await openFeed(token);

        expect((await request(server, 'DELETE', `/api/auth/keys/${key.id}`, { token: session })).ok).toBe(true);

        expect(await feed.endsSoon()).toBe('ended');
    });

    it('ends when its API key is rotated', async () => {
        const { token, key } = await mintKey('view');
        const feed = await openFeed(token);

        expect((await request(server, 'POST', `/api/auth/keys/${key.id}/rotate`, { token: session })).ok).toBe(true);

        expect(await feed.endsSoon()).toBe('ended');
    });

    it('stays open when a different credential is revoked', async () => {
        const feed = await openFeed(session);
        const other = await mintKey('view');

        await request(server, 'DELETE', `/api/auth/keys/${other.key.id}`, { token: session });

        expect(await feed.endsSoon()).toBe('open');
        await feed.cancel();
    });
});
