import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSignedIn } from '#src/checks/api.signed.in.js';

/** `signed in to the API`, against a stubbed `fetch`; the keyring is stubbed for every CLI test. */
const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ctx = () => ({ env: {}, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }) as never;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('signed in to the API', () => {
    it('passes, naming the account, when the credential works', async () => {
        fetchMock.mockResolvedValueOnce(
            json({ accountId: 'a', username: 'operator', issuedAt: '2026-10-29T00:00:00Z', expiresAt: '2026-10-29T01:00:00Z' }),
        );

        const result = await apiSignedIn.run(ctx());

        expect(result).toMatchObject({ ok: true });
        expect(result.message).toContain('as operator');
    });

    it('fails with the fix when the API refuses the credential', async () => {
        fetchMock.mockResolvedValueOnce(json({}, 401));

        const result = await apiSignedIn.run(ctx());

        expect(result).toMatchObject({ ok: false });
        expect(result.fixHint).toContain('wilson auth login');
    });

    it('passes when the API is not reachable, leaving that to the daemon check', async () => {
        fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));

        expect(await apiSignedIn.run(ctx())).toMatchObject({ ok: true });
    });
});
