import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyringEntry } from '@maroonedsoftware/johnny5/keyring';
import { apiClient, describeApiError } from '#src/api-client.js';
import { keyAccount, keyStore, resolveToken, type KeyStore } from '#src/credentials.js';
import { login, type LoginIo } from '#src/commands/auth/login.command.js';
import { logout } from '#src/commands/auth/logout.command.js';
import { status } from '#src/commands/auth/status.command.js';
import { token } from '#src/commands/auth/token.command.js';
import { SdkError } from '@wilson/sdk';

/**
 * `wilson auth` against a stubbed `fetch` (the seam `createSdkFetch` calls, as the other command
 * tests stub it) and an in-memory keyring entry, so nothing here reaches a server or the
 * developer's own keychain.
 */
const memoryEntry = (initial: string | null = null): KeyringEntry & { value: string | null } => {
    const entry = {
        value: initial,
        read: async () => entry.value,
        write: async (value: string) => {
            entry.value = value;
            return true;
        },
        delete: async () => {
            entry.value = null;
            return true;
        },
    };
    return entry;
};

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const buildCtx = (env: Record<string, string> = {}) => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { ctx: { env, logger, config: { get: (_k: string, f: string) => f } } as never, logger };
};

const io = (answers: { username?: string; password?: string; stdin?: string; code?: string }): LoginIo => ({
    ask: async () => answers.username,
    askSecret: async (message: string) => (message.startsWith('Code') ? answers.code : answers.password),
    readStdin: async () => answers.stdin ?? '',
});

const KEY = { id: 'key-1', name: 'wilson cli on host', hint: 'abcd1234', scope: 'manage', createdAt: '2026-10-29T00:00:00Z' };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

/** The `[url, init]` of every fetch call, with headers flattened for asserting on. */
const calls = () =>
    fetchMock.mock.calls.map(([url, init]: [string, RequestInit]) => ({
        url,
        method: init.method,
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(init.body as string) : undefined,
    }));

describe('keyAccount', () => {
    it('files a key under the API origin, so two APIs never share a slot', () => {
        expect(keyAccount('http://localhost:13100/')).toBe('apikey:http://localhost:13100');
        expect(keyAccount('https://wilson.example')).not.toBe(keyAccount('http://localhost:13100'));
    });
});

describe('resolveToken', () => {
    it('prefers WILSON_API_KEY over the keyring', async () => {
        const store = keyStore(memoryEntry(JSON.stringify({ token: 'wl_stored', id: 'k', name: 'n' })));

        expect(await resolveToken(buildCtx({ WILSON_API_KEY: 'wl_env' }).ctx, store)).toBe('wl_env');
        expect(await resolveToken(buildCtx().ctx, store)).toBe('wl_stored');
    });

    it('reads an unreadable keyring entry as signed out', async () => {
        expect(await resolveToken(buildCtx().ctx, keyStore(memoryEntry('not json')))).toBeUndefined();
    });
});

describe('apiClient', () => {
    it('signs every request with the stored key', async () => {
        fetchMock.mockResolvedValue(json([]));
        const store = keyStore(memoryEntry(JSON.stringify({ token: 'wl_stored', id: 'k', name: 'n' })));

        await apiClient(buildCtx().ctx, store).apiKeys.listApiKeys();

        expect(calls()[0]!.headers.Authorization).toBe('Bearer wl_stored');
    });

    it('sends no Authorization header when there is no key', async () => {
        fetchMock.mockResolvedValue(json([]));

        await apiClient(buildCtx().ctx, keyStore(memoryEntry())).apiKeys.listApiKeys();

        expect(calls()[0]!.headers.Authorization).toBeUndefined();
    });
});

describe('describeApiError', () => {
    it('turns a 401 into how to sign in', () => {
        const message = describeApiError(new SdkError(401, 'Unauthorized', {}, new Headers()), buildCtx().ctx);

        expect(message).toContain('wilson auth login');
    });
});

describe('wilson auth login', () => {
    it('signs in, stores a manage key, and signs the password session out again', async () => {
        fetchMock
            .mockResolvedValueOnce(json({ result: 'token', accessToken: 'session-jwt', refreshToken: 'r', expiresIn: 1, tokenType: 'Bearer' }))
            .mockResolvedValueOnce(json({ key: KEY, token: 'wl_new' }, 201))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        const entry = memoryEntry();
        const { ctx } = buildCtx();

        expect(await login({}, ctx, io({ username: 'operator', password: 'pw' }), keyStore(entry))).toBe(0);

        const [signIn, create, signOut] = calls();
        expect(signIn).toMatchObject({ method: 'POST', body: { grant_type: 'password', username: 'operator', password: 'pw' } });
        expect(signIn!.headers.Authorization).toBeUndefined();
        expect(create).toMatchObject({ method: 'POST', body: { scope: 'manage' } });
        expect(create!.headers.Authorization).toBe('Bearer session-jwt');
        expect(signOut!.url).toContain('/api/auth/logout');
        expect(JSON.parse(entry.value!)).toEqual({ token: 'wl_new', id: 'key-1', name: KEY.name });
    });

    it('revokes the key a second login replaces', async () => {
        fetchMock
            .mockResolvedValueOnce(json({ result: 'token', accessToken: 'session-jwt', refreshToken: 'r', expiresIn: 1, tokenType: 'Bearer' }))
            .mockResolvedValueOnce(json({ key: KEY, token: 'wl_new' }, 201))
            .mockResolvedValueOnce(json({ ...KEY, id: 'key-0', revokedAt: '2026-10-29T00:00:00Z' }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        const entry = memoryEntry(JSON.stringify({ token: 'wl_old', id: 'key-0', name: 'old' }));

        expect(await login({}, buildCtx().ctx, io({ username: 'operator', password: 'pw' }), keyStore(entry))).toBe(0);

        expect(calls()[2]).toMatchObject({ method: 'DELETE' });
        expect(calls()[2]!.url).toContain('/api/auth/keys/key-0');
    });

    it('reads the password from stdin with --password-stdin, trimming the newline', async () => {
        fetchMock
            .mockResolvedValueOnce(json({ result: 'token', accessToken: 'session-jwt', refreshToken: 'r', expiresIn: 1, tokenType: 'Bearer' }))
            .mockResolvedValueOnce(json({ key: KEY, token: 'wl_new' }, 201))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));

        await login({ username: 'operator', passwordStdin: true }, buildCtx().ctx, io({ stdin: 'from-stdin\n' }), keyStore(memoryEntry()));

        expect(calls()[0]!.body.password).toBe('from-stdin');
    });

    it('asks for the authenticator code when the password answers mfa_required, and signs in with it', async () => {
        fetchMock
            .mockResolvedValueOnce(
                json({ result: 'mfa_required', challengeId: 'ch-1', factors: [{ method: 'authenticator', id: 'f-1', label: 'phone' }] }),
            )
            .mockResolvedValueOnce(json({ result: 'token', accessToken: 'session-jwt', refreshToken: 'r', expiresIn: 1, tokenType: 'Bearer' }))
            .mockResolvedValueOnce(json({ key: KEY, token: 'wl_new' }, 201))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        const entry = memoryEntry();

        expect(await login({}, buildCtx().ctx, io({ username: 'operator', password: 'pw', code: '123456' }), keyStore(entry))).toBe(0);

        expect(calls()[1]!.body).toEqual({ grant_type: 'authenticator', challenge_id: 'ch-1', factor_id: 'f-1', code: '123456' });
        expect(calls()[2]!.headers.Authorization).toBe('Bearer session-jwt');
        expect(JSON.parse(entry.value!).token).toBe('wl_new');
    });

    it('says the code was wrong', async () => {
        fetchMock
            .mockResolvedValueOnce(json({ result: 'mfa_required', challengeId: 'ch-1', factors: [{ method: 'authenticator', id: 'f-1' }] }))
            .mockResolvedValueOnce(json({}, 401));
        const { ctx, logger } = buildCtx();

        expect(await login({}, ctx, io({ username: 'operator', password: 'pw', code: '000000' }), keyStore(memoryEntry()))).toBe(1);

        expect(logger.error).toHaveBeenCalledWith('wrong code');
    });

    it('says the password was wrong, and stores nothing', async () => {
        fetchMock.mockResolvedValueOnce(json({}, 401));
        const entry = memoryEntry();
        const { ctx, logger } = buildCtx();

        expect(await login({}, ctx, io({ username: 'operator', password: 'bad' }), keyStore(entry))).toBe(1);

        expect(logger.error).toHaveBeenCalledWith('wrong username or password');
        expect(entry.value).toBeNull();
    });

    it('revokes the new key when the keyring cannot hold it', async () => {
        fetchMock
            .mockResolvedValueOnce(json({ result: 'token', accessToken: 'session-jwt', refreshToken: 'r', expiresIn: 1, tokenType: 'Bearer' }))
            .mockResolvedValueOnce(json({ key: KEY, token: 'wl_new' }, 201))
            .mockResolvedValueOnce(json({ ...KEY, revokedAt: '2026-10-29T00:00:00Z' }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        const broken: KeyStore = { read: async () => undefined, write: async () => false, clear: async () => true };

        expect(await login({}, buildCtx().ctx, io({ username: 'operator', password: 'pw' }), broken)).toBe(1);

        expect(calls()[2]).toMatchObject({ method: 'DELETE' });
    });
});

describe('wilson auth logout', () => {
    it('revokes the stored key and forgets it', async () => {
        fetchMock.mockResolvedValueOnce(json({ ...KEY, revokedAt: '2026-10-29T00:00:00Z' }));
        const entry = memoryEntry(JSON.stringify({ token: 'wl_stored', id: 'key-1', name: KEY.name }));

        expect(await logout(buildCtx().ctx, keyStore(entry))).toBe(0);

        expect(calls()[0]).toMatchObject({ method: 'DELETE' });
        expect(calls()[0]!.headers.Authorization).toBe('Bearer wl_stored');
        expect(entry.value).toBeNull();
    });

    it('forgets the key even when the server cannot be reached, and says so', async () => {
        fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
        const entry = memoryEntry(JSON.stringify({ token: 'wl_stored', id: 'key-1', name: KEY.name }));
        const { ctx, logger } = buildCtx();

        expect(await logout(ctx, keyStore(entry))).toBe(0);

        expect(entry.value).toBeNull();
        expect(logger.warn).toHaveBeenCalled();
    });
});

describe('wilson auth status and token', () => {
    it('reports who the key signs in as', async () => {
        fetchMock.mockResolvedValueOnce(
            json({ accountId: 'a', username: 'operator', issuedAt: '2026-10-29T00:00:00Z', expiresAt: '2026-10-29T01:00:00Z' }),
        );
        const { ctx, logger } = buildCtx();

        expect(await status(ctx, keyStore(memoryEntry(JSON.stringify({ token: 'wl_stored', id: 'k', name: 'n' }))))).toBe(0);

        expect(logger.info.mock.calls[0]![0]).toContain('as operator');
    });

    it('reports a key the server no longer accepts', async () => {
        fetchMock.mockResolvedValueOnce(json({}, 401));
        const { ctx, logger } = buildCtx();

        expect(await status(ctx, keyStore(memoryEntry(JSON.stringify({ token: 'wl_stored', id: 'k', name: 'n' }))))).toBe(1);

        expect(logger.info.mock.calls[0]![0]).toContain('no longer works');
    });

    it('prints the stored key alone, for capture', async () => {
        const out: string[] = [];

        expect(
            await token(buildCtx().ctx, keyStore(memoryEntry(JSON.stringify({ token: 'wl_stored', id: 'k', name: 'n' }))), text => out.push(text)),
        ).toBe(0);

        expect(out).toEqual(['wl_stored\n']);
    });

    it('fails with no key to print', async () => {
        expect(await token(buildCtx().ctx, keyStore(memoryEntry()), () => undefined)).toBe(1);
    });
});

describe('withStepUp', () => {
    const stepUpRefusal = () => json({ details: { kind: 'step_up_unavailable', reason: 'an API key cannot do this' } }, 403);
    const keyed = () => apiClient(buildCtx().ctx, keyStore(memoryEntry(JSON.stringify({ token: 'wl_stored', id: 'k', name: 'n' }))));

    it('makes the call once with the key when the API accepts it', async () => {
        fetchMock.mockResolvedValueOnce(json([]));
        const { withStepUp } = await import('#src/sign.in.js');

        await withStepUp(buildCtx().ctx, keyed(), api => api.apiKeys.listApiKeys(), io({}));

        expect(calls()).toHaveLength(1);
    });

    it('on a step-up refusal, asks for the password, retries with a fresh session, and signs it out', async () => {
        fetchMock
            .mockResolvedValueOnce(stepUpRefusal())
            .mockResolvedValueOnce(
                json({ accountId: 'a', username: 'operator', issuedAt: '2026-10-29T00:00:00Z', expiresAt: '2026-10-29T01:00:00Z' }),
            )
            .mockResolvedValueOnce(json({ result: 'token', accessToken: 'fresh-session', refreshToken: 'r', expiresIn: 1, tokenType: 'Bearer' }))
            .mockResolvedValueOnce(json({ id: 'v2', yaml: 'x', message: 'm', createdAt: '2026-10-29T00:00:00Z' }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        const { withStepUp } = await import('#src/sign.in.js');

        await withStepUp(buildCtx().ctx, keyed(), api => api.stages.setStageConfig({ yaml: 'x' }), io({ password: 'pw' }));

        const [first, , signIn, retry, signOut] = calls();
        expect(first!.headers.Authorization).toBe('Bearer wl_stored');
        expect(signIn!.body).toMatchObject({ grant_type: 'password', username: 'operator', password: 'pw' });
        expect(retry!.headers.Authorization).toBe('Bearer fresh-session');
        expect(retry!.method).toBe('PUT');
        expect(signOut!.url).toContain('/api/auth/logout');
    });

    it('rethrows any other refusal without prompting', async () => {
        fetchMock.mockResolvedValueOnce(json({ details: { reason: 'invalid yaml' } }, 400));
        const askSecret = vi.fn();
        const { withStepUp } = await import('#src/sign.in.js');

        await expect(
            withStepUp(buildCtx().ctx, keyed(), api => api.stages.setStageConfig({ yaml: 'x' }), { ...io({}), askSecret }),
        ).rejects.toMatchObject({
            status: 400,
        });
        expect(askSecret).not.toHaveBeenCalled();
    });
});
