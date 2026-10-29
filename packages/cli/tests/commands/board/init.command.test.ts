import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyStore } from '#src/credentials.js';
import { init } from '#src/commands/board/init.command.js';
import type { LoginIo } from '#src/sign.in.js';

/**
 * `wilson board init` on a fresh install: the 401 that sends it into onboarding or sign-in. The
 * signed-in path (one call, the stages reported, a 409 explained) is covered by
 * apps/api/tests/cli/board.init.command.test.ts. A stubbed `fetch` and an in-memory keyring entry,
 * as in the auth command tests.
 */
const memoryEntry = (initial: string | null = null) => {
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

/** Answers prompts in order: `ask` from `asked`, `askSecret` from `secrets`. */
const scripted = (asked: (string | undefined)[], secrets: (string | undefined)[], stdin = ''): LoginIo & { secretsAsked: string[] } => {
    const secretsAsked: string[] = [];
    return {
        secretsAsked,
        ask: async () => asked.shift(),
        askSecret: async message => {
            secretsAsked.push(message);
            return secrets.shift();
        },
        readStdin: async () => stdin,
    };
};

const KEY = { id: 'key-1', name: 'wilson cli on host', hint: 'abcd1234', scope: 'manage', createdAt: '2026-10-29T00:00:00Z' };
const COLUMNS = { stages: ['planning', 'implementing'], nonStages: ['parking-lot'] };
const unauthorised = () => json({}, 401);
const token = () => json({ result: 'token', accessToken: 'session-jwt', refreshToken: 'r', expiresIn: 1, tokenType: 'Bearer' });
const signedOut = () => new Response(null, { status: 204 });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

const calls = () =>
    fetchMock.mock.calls.map(([url, init]: [string, RequestInit]) => ({
        url,
        method: init.method,
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(init.body as string) : undefined,
    }));

describe('wilson board init on a fresh install', () => {
    it('creates the operator account, signs this machine in, and initialises the board with the new key', async () => {
        fetchMock
            .mockResolvedValueOnce(unauthorised())
            .mockResolvedValueOnce(json({ accountExists: false }))
            .mockResolvedValueOnce(json({ accountExists: true }, 201))
            .mockResolvedValueOnce(token())
            .mockResolvedValueOnce(json({ key: KEY, token: 'wl_new' }, 201))
            .mockResolvedValueOnce(signedOut())
            .mockResolvedValueOnce(json(COLUMNS, 201));
        const entry = memoryEntry();
        const { ctx, logger } = buildCtx();

        expect(await init({}, ctx, scripted(['operator'], ['a long passphrase', 'a long passphrase']), keyStore(entry))).toBe(0);

        const urls = calls().map(call => `${call.method} ${new URL(call.url).pathname}`);
        expect(urls).toEqual([
            'POST /api/board/init',
            'GET /api/onboarding',
            'POST /api/onboarding',
            'POST /api/auth/token',
            'POST /api/auth/keys',
            'POST /api/auth/logout',
            'POST /api/board/init',
        ]);
        expect(calls()[2]!.body).toEqual({ username: 'operator', password: 'a long passphrase' });
        expect(calls()[6]!.headers.Authorization).toBe('Bearer wl_new');
        expect(JSON.parse(entry.value!).token).toBe('wl_new');
        expect(logger.info).toHaveBeenCalledWith('board initialised — stages: planning, implementing');
    });

    it('asks again when the two passwords differ', async () => {
        fetchMock
            .mockResolvedValueOnce(unauthorised())
            .mockResolvedValueOnce(json({ accountExists: false }))
            .mockResolvedValueOnce(json({ accountExists: true }, 201))
            .mockResolvedValueOnce(token())
            .mockResolvedValueOnce(json({ key: KEY, token: 'wl_new' }, 201))
            .mockResolvedValueOnce(signedOut())
            .mockResolvedValueOnce(json(COLUMNS, 201));
        const { ctx, logger } = buildCtx();

        expect(await init({}, ctx, scripted(['operator'], ['first try', 'typo', 'second try', 'second try']), keyStore(memoryEntry()))).toBe(0);

        expect(logger.warn).toHaveBeenCalledWith('those did not match; try again');
        expect(calls()[2]!.body.password).toBe('second try');
    });

    it("explains a password the policy refuses, with zxcvbn's advice, and asks again", async () => {
        fetchMock
            .mockResolvedValueOnce(unauthorised())
            .mockResolvedValueOnce(json({ accountExists: false }))
            .mockResolvedValueOnce(json({ details: { password: 'This is a very common password.', suggestions: ['Add another word.'] } }, 400))
            .mockResolvedValueOnce(json({ accountExists: true }, 201))
            .mockResolvedValueOnce(token())
            .mockResolvedValueOnce(json({ key: KEY, token: 'wl_new' }, 201))
            .mockResolvedValueOnce(signedOut())
            .mockResolvedValueOnce(json(COLUMNS, 201));
        const { ctx, logger } = buildCtx();

        expect(await init({}, ctx, scripted(['operator'], ['password1', 'password1', 'a long passphrase', 'a long passphrase']), keyStore(memoryEntry()))).toBe(0);

        expect(logger.warn).toHaveBeenCalledWith('that password is too easy to guess. This is a very common password. Add another word.');
        expect(calls()[3]!.body.password).toBe('a long passphrase');
    });

    it('takes the password once from stdin, and fails rather than asking again when the policy refuses it', async () => {
        fetchMock
            .mockResolvedValueOnce(unauthorised())
            .mockResolvedValueOnce(json({ accountExists: false }))
            .mockResolvedValueOnce(json({ details: { password: 'Too short.' } }, 400));
        const io = scripted([], [], 'password1\n');
        const { ctx, logger } = buildCtx();

        expect(await init({ username: 'operator', passwordStdin: true }, ctx, io, keyStore(memoryEntry()))).toBe(1);

        expect(calls()[2]!.body).toEqual({ username: 'operator', password: 'password1' });
        expect(io.secretsAsked).toEqual([]);
        expect(logger.error).toHaveBeenCalledWith('that password is too easy to guess. Too short.');
    });

    it('signs in to the account there is when one exists, and initialises the board', async () => {
        fetchMock
            .mockResolvedValueOnce(unauthorised())
            .mockResolvedValueOnce(json({ accountExists: true }))
            .mockResolvedValueOnce(token())
            .mockResolvedValueOnce(json({ key: KEY, token: 'wl_new' }, 201))
            .mockResolvedValueOnce(signedOut())
            .mockResolvedValueOnce(json(COLUMNS, 201));
        const io = scripted(['operator'], ['pw']);

        expect(await init({}, buildCtx().ctx, io, keyStore(memoryEntry()))).toBe(0);

        expect(calls()[2]!.body).toMatchObject({ grant_type: 'password', username: 'operator', password: 'pw' });
        expect(io.secretsAsked).toEqual(['Password']);
        expect(calls()[5]!.headers.Authorization).toBe('Bearer wl_new');
    });

    it('stops without initialising when that sign-in fails', async () => {
        fetchMock
            .mockResolvedValueOnce(unauthorised())
            .mockResolvedValueOnce(json({ accountExists: true }))
            .mockResolvedValueOnce(unauthorised());
        const { ctx, logger } = buildCtx();

        expect(await init({}, ctx, scripted(['operator'], ['wrong']), keyStore(memoryEntry()))).toBe(1);

        expect(logger.error).toHaveBeenCalledWith('wrong username or password');
        expect(logger.error).toHaveBeenLastCalledWith('not signed in, so the board was not initialised');
        expect(calls()).toHaveLength(3);
    });

    it('does not prompt when WILSON_API_KEY is what the API refused', async () => {
        fetchMock.mockResolvedValueOnce(unauthorised());
        const { ctx, logger } = buildCtx({ WILSON_API_KEY: 'wl_stale' });

        expect(await init({}, ctx, scripted([], []), keyStore(memoryEntry()))).toBe(1);

        expect(calls()).toHaveLength(1);
        expect(logger.error.mock.calls[0]![0]).toContain('wilson auth login');
    });
});
