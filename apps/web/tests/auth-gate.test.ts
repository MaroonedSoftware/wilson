// @vitest-environment jsdom
//
// Signing in to the web app (PROJECT.md, Authentication): `AuthGate`'s three outcomes on load, the
// two forms, and `sessionFetch`'s bearer, cookie opt-in and refresh-once-on-401. The network is a
// stubbed `fetch`, the one place a request's headers and credentials can be observed. `tests/setup.ts`
// signs every test in; each test here starts signed out instead.
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from '#src/components/AuthGate.js';
import { signOut } from '#src/lib/auth.js';
import { API_BASE } from '#src/lib/sdk.js';
import { currentAccessToken, sessionFetch, setAccessToken } from '#src/lib/session.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    setAccessToken(undefined);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // Mantine reads the colour scheme through `matchMedia`, which jsdom does not provide.
    vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

/** Answers by URL: `routes` maps a path to the response (or responses, in order) it gets. */
const route = (routes: Record<string, Response | Response[]>) =>
    fetchMock.mockImplementation(async (url: string) => {
        const path = url.replace(API_BASE, '');
        const answer = routes[path];
        if (!answer) throw new Error(`unexpected request to ${path}`);
        return Array.isArray(answer) ? answer.shift()! : answer.clone();
    });

const renderGate = () => render(createElement(MantineProvider, null, createElement(AuthGate, null, createElement('p', null, 'the board'))));

/** By label, anchored at its start: Mantine appends a required marker, and "Password" must not also
 * match "Confirm password". */
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });

const callsTo = (path: string) => fetchMock.mock.calls.filter(([url]: [string]) => url === `${API_BASE}${path}`) as [string, RequestInit][];

describe('AuthGate on load', () => {
    it('shows onboarding when there is no account yet', async () => {
        route({ '/api/onboarding': json(200, { accountExists: false }) });

        renderGate();

        expect(await screen.findByText('Create your account')).toBeTruthy();
        expect(screen.queryByText('the board')).toBeNull();
    });

    it('shows sign-in when there is an account but no session to restore', async () => {
        route({ '/api/onboarding': json(200, { accountExists: true }), '/api/auth/token': json(401, {}) });

        renderGate();

        expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    });

    it('restores the session from the refresh cookie and shows the app', async () => {
        route({
            '/api/onboarding': json(200, { accountExists: true }),
            '/api/auth/token': json(200, { accessToken: 'restored', expiresIn: 1, tokenType: 'Bearer' }),
        });

        renderGate();

        expect(await screen.findByText('the board')).toBeTruthy();
        expect(currentAccessToken()).toBe('restored');
        const [, init] = callsTo('/api/auth/token')[0]!;
        expect(init.credentials).toBe('include');
        expect(JSON.parse(init.body as string)).toEqual({ grant_type: 'refresh_token' });
    });

    it('renders the app at once when a token is already in memory', () => {
        setAccessToken('in-memory');

        renderGate();

        expect(screen.getByText('the board')).toBeTruthy();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('the sign-in form', () => {
    beforeEach(() => {
        route({
            '/api/onboarding': json(200, { accountExists: true }),
            '/api/auth/token': [json(401, {}), json(401, {}), json(200, { accessToken: 'signed-in', expiresIn: 1, tokenType: 'Bearer' })],
        });
    });

    it('signs in, opting into cookies, and shows the app', async () => {
        renderGate();
        await screen.findByRole('button', { name: 'Sign in' });
        fill('Username', 'operator');
        fill('Password', 'wrong');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

        expect(await screen.findByText('Wrong username or password.')).toBeTruthy();

        fill('Password', 'right');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

        expect(await screen.findByText('the board')).toBeTruthy();
        const [, init] = callsTo('/api/auth/token').at(-1)!;
        expect((init.headers as Record<string, string>)['x-wilson-cookies']).toBe('1');
        expect(JSON.parse(init.body as string)).toMatchObject({ grant_type: 'password', username: 'operator', password: 'right' });
    });
});

describe('the onboarding form', () => {
    it('refuses mismatched passwords without calling the API', async () => {
        route({ '/api/onboarding': json(200, { accountExists: false }) });
        renderGate();
        await screen.findByText('Create your account');

        fill('Username', 'operator');
        fill('Password', 'correct horse battery staple');
        fill('Confirm password', 'something else');
        fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

        expect(await screen.findByText('The passwords do not match.')).toBeTruthy();
        expect(callsTo('/api/onboarding').filter(([, init]) => init.method === 'POST')).toHaveLength(0);
    });

    it("explains a weak password with the policy's own advice", async () => {
        route({
            '/api/onboarding': [
                json(200, { accountExists: false }),
                json(400, { details: { password: 'This is a top-10 common password.', suggestions: ['Add more words.'] } }),
            ],
        });
        renderGate();
        await screen.findByText('Create your account');

        fill('Username', 'operator');
        fill('Password', 'password1');
        fill('Confirm password', 'password1');
        fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

        expect(await screen.findByText(/too easy to guess. This is a top-10 common password. Add more words./)).toBeTruthy();
    });

    it('creates the account and signs straight in', async () => {
        route({
            '/api/onboarding': [json(200, { accountExists: false }), json(201, { accountExists: true })],
            '/api/auth/token': json(200, { accessToken: 'new', expiresIn: 1, tokenType: 'Bearer' }),
        });
        renderGate();
        await screen.findByText('Create your account');

        fill('Username', 'operator');
        fill('Password', 'correct horse battery staple');
        fill('Confirm password', 'correct horse battery staple');
        fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

        expect(await screen.findByText('the board')).toBeTruthy();
    });
});

describe('signing out', () => {
    it('drops back to the sign-in form, and the token is gone', async () => {
        route({ '/api/auth/logout': new Response(null, { status: 204 }), '/api/onboarding': json(200, { accountExists: true }) });
        setAccessToken('in-memory');
        renderGate();

        await signOut();

        expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
        expect(currentAccessToken()).toBeUndefined();
    });
});

describe('sessionFetch', () => {
    const sdkFetch = () => sessionFetch({ baseUrl: API_BASE });

    it('sends the bearer token, the cookie opt-in, and credentials', async () => {
        setAccessToken('token-a');
        route({ '/api/cards': json(200, []) });

        await sdkFetch()('/api/cards', { method: 'GET' });

        const [, init] = callsTo('/api/cards')[0]!;
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-a');
        expect((init.headers as Record<string, string>)['x-wilson-cookies']).toBe('1');
        expect(init.credentials).toBe('include');
    });

    it('refreshes once on a 401 and replays the request with the new token', async () => {
        setAccessToken('stale');
        route({
            '/api/cards': [json(401, {}), json(200, [])],
            '/api/auth/token': json(200, { accessToken: 'fresh', expiresIn: 1, tokenType: 'Bearer' }),
        });

        const res = await sdkFetch()('/api/cards', { method: 'GET' });

        expect(res.status).toBe(200);
        expect((callsTo('/api/cards')[1]![1].headers as Record<string, string>).Authorization).toBe('Bearer fresh');
    });

    /** The refresh token is single-use: two redemptions at once would read as a replay. */
    it('shares one refresh between concurrent 401s', async () => {
        setAccessToken('stale');
        route({
            '/api/cards': [json(401, {}), json(401, {}), json(200, []), json(200, [])],
            '/api/auth/token': json(200, { accessToken: 'fresh', expiresIn: 1, tokenType: 'Bearer' }),
        });

        await Promise.all([sdkFetch()('/api/cards', { method: 'GET' }), sdkFetch()('/api/cards', { method: 'GET' })]);

        expect(callsTo('/api/auth/token')).toHaveLength(1);
    });

    it('drops the token when the refresh is refused, and throws the 401', async () => {
        setAccessToken('stale');
        route({ '/api/cards': json(401, {}), '/api/auth/token': json(401, {}) });

        await expect(sdkFetch()('/api/cards', { method: 'GET' })).rejects.toMatchObject({ status: 401 });
        expect(currentAccessToken()).toBeUndefined();
    });

    it('never retries the token endpoint itself, so a wrong password is just a 401', async () => {
        route({ '/api/auth/token': json(401, {}) });

        await expect(sdkFetch()('/api/auth/token', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 401 });
        expect(callsTo('/api/auth/token')).toHaveLength(1);
    });
});
