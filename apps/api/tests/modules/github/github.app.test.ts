import { createVerify, generateKeyPairSync } from 'node:crypto';
import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GitHubApp } from '#modules/github/github.app.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('GitHubApp', () => {
    let privateKey: string;
    let publicKey: string;

    beforeAll(() => {
        ({ privateKey, publicKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        }));
    });

    const bearer = (init?: RequestInit) => (init?.headers as Record<string, string>).Authorization!.replace('Bearer ', '');

    /** Answers the three endpoints, recording each URL it was asked for. */
    const github = (expiresAt = DateTime.now().plus({ hours: 1 }).toISO()) => {
        const calls: { url: string; bearer: string; method: string }[] = [];
        const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const href = String(url);
            calls.push({ url: href, bearer: bearer(init), method: init?.method ?? 'GET' });
            if (href.endsWith('/repos/acme/app/installation')) return json(200, { id: 7 });
            if (href.endsWith('/repos/acme/missing/installation')) return json(404, { message: 'Not Found' });
            if (href.endsWith('/access_tokens')) return json(201, { token: `token-${calls.length}`, expires_at: expiresAt });
            if (href.includes('/app/installations')) return json(200, [{ id: 7 }, { id: 8 }]);
            if (href.includes('/installation/repositories')) {
                return json(200, { repositories: [{ full_name: 'acme/app', private: true, default_branch: 'main' }] });
            }
            return json(500, {});
        });
        return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
    };

    it('signs as the app with an RS256 JWT GitHub will accept', async () => {
        const { fetchImpl, calls } = github();

        await new GitHubApp({ appId: '123', privateKey }, fetchImpl).tokenFor('acme/app');

        const [header, payload, signature] = calls[0]!.bearer.split('.') as [string, string, string];
        expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iat: number; exp: number; iss: string };
        expect(claims.iss).toBe('123');
        expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
        expect(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    });

    it('asks for the token of the installation that holds the repository', async () => {
        const { fetchImpl, calls } = github();

        const token = await new GitHubApp({ appId: '123', privateKey }, fetchImpl).tokenFor('acme/app');

        expect(token).toBe('token-2');
        expect(calls[1]).toMatchObject({ url: 'https://api.github.com/app/installations/7/access_tokens', method: 'POST' });
    });

    it('keeps a token until it nears expiry', async () => {
        const { fetchImpl, calls } = github();
        const app = new GitHubApp({ appId: '123', privateKey }, fetchImpl);

        await app.tokenFor('acme/app');
        await app.tokenFor('acme/app');

        expect(calls.filter(call => call.url.endsWith('/access_tokens'))).toHaveLength(1);
    });

    it('replaces a token about to expire', async () => {
        const { fetchImpl, calls } = github(DateTime.now().plus({ minutes: 2 }).toISO());
        const app = new GitHubApp({ appId: '123', privateKey }, fetchImpl);

        await app.tokenFor('acme/app');
        await app.tokenFor('acme/app');

        expect(calls.filter(call => call.url.endsWith('/access_tokens'))).toHaveLength(2);
    });

    it('says so when the app is not installed on a repository', async () => {
        const { fetchImpl } = github();

        await expect(new GitHubApp({ appId: '123', privateKey }, fetchImpl).tokenFor('acme/missing')).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: 'the GitHub App is not installed on acme/missing' },
        });
    });

    it('lists the repositories of every installation, using that installation\'s token', async () => {
        const { fetchImpl, calls } = github();

        const repositories = await new GitHubApp({ appId: '123', privateKey }, fetchImpl).repositories();

        expect(repositories[0]).toEqual({ fullName: 'acme/app', private: true, defaultBranch: 'main' });
        expect(repositories).toHaveLength(2);
        expect(calls.filter(call => call.url.includes('/installation/repositories')).every(call => call.bearer.startsWith('token-'))).toBe(true);
    });

    it('follows pagination', async () => {
        const fetchImpl = vi.fn(async (url: string | URL | Request) => {
            const href = String(url);
            if (href.endsWith('/access_tokens')) return json(201, { token: 't', expires_at: DateTime.now().plus({ hours: 1 }).toISO() });
            if (href.includes('/app/installations')) return json(200, [{ id: 7 }]);
            if (href.endsWith('page=2')) return json(200, { repositories: [{ full_name: 'acme/b', private: false, default_branch: 'main' }] });
            return json(
                200,
                { repositories: [{ full_name: 'acme/a', private: false, default_branch: 'main' }] },
                { link: '<https://api.github.com/installation/repositories?page=2>; rel="next"' },
            );
        }) as unknown as typeof fetch;

        const repositories = await new GitHubApp({ appId: '123', privateKey }, fetchImpl).repositories();

        expect(repositories.map(repo => repo.fullName)).toEqual(['acme/a', 'acme/b']);
    });

    it('refuses with what to set when no app is configured, and calls nothing', async () => {
        const { fetchImpl, calls } = github();
        const app = new GitHubApp(undefined, fetchImpl);

        expect(app.configured).toBe(false);
        await expect(app.tokenFor('acme/app')).rejects.toMatchObject({ statusCode: 400 });
        expect(calls).toEqual([]);
    });
});
