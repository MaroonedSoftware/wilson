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

    const identity = () => ({ appId: async () => '123', privateKey: async () => privateKey });

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

        await new GitHubApp(identity(), fetchImpl).tokenFor('acme/app');

        const [header, payload, signature] = calls[0]!.bearer.split('.') as [string, string, string];
        expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iat: number; exp: number; iss: string };
        expect(claims.iss).toBe('123');
        expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
        expect(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    });

    it('asks for the token of the installation that holds the repository', async () => {
        const { fetchImpl, calls } = github();

        const token = await new GitHubApp(identity(), fetchImpl).tokenFor('acme/app');

        expect(token).toBe('token-2');
        expect(calls[1]).toMatchObject({ url: 'https://api.github.com/app/installations/7/access_tokens', method: 'POST' });
    });

    it('keeps a token until it nears expiry', async () => {
        const { fetchImpl, calls } = github();
        const app = new GitHubApp(identity(), fetchImpl);

        await app.tokenFor('acme/app');
        await app.tokenFor('acme/app');

        expect(calls.filter(call => call.url.endsWith('/access_tokens'))).toHaveLength(1);
    });

    it('replaces a token about to expire', async () => {
        const { fetchImpl, calls } = github(DateTime.now().plus({ minutes: 2 }).toISO());
        const app = new GitHubApp(identity(), fetchImpl);

        await app.tokenFor('acme/app');
        await app.tokenFor('acme/app');

        expect(calls.filter(call => call.url.endsWith('/access_tokens'))).toHaveLength(2);
    });

    it('says so when the app is not installed on a repository', async () => {
        const { fetchImpl } = github();

        await expect(new GitHubApp(identity(), fetchImpl).tokenFor('acme/missing')).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: 'the GitHub App is not installed on acme/missing' },
        });
    });

    it("lists the repositories of every installation, using that installation's token", async () => {
        const { fetchImpl, calls } = github();

        const repositories = await new GitHubApp(identity(), fetchImpl).repositories();

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

        const repositories = await new GitHubApp(identity(), fetchImpl).repositories();

        expect(repositories.map(repo => repo.fullName)).toEqual(['acme/a', 'acme/b']);
    });

    it('refuses with what to set when no app is configured, and calls nothing', async () => {
        const { fetchImpl, calls } = github();
        const app = new GitHubApp({ appId: async () => '123', privateKey: async () => undefined }, fetchImpl);

        expect(await app.isConfigured()).toBe(false);
        await expect(app.tokenFor('acme/app')).rejects.toMatchObject({ statusCode: 400 });
        expect(calls).toEqual([]);
    });

    it('picks up an id and key that appear after it was built', async () => {
        const { fetchImpl } = github();
        let appId: string | undefined;
        const app = new GitHubApp({ appId: async () => appId, privateKey: async () => privateKey }, fetchImpl);

        expect(await app.isConfigured()).toBe(false);
        appId = '123';
        expect(await app.isConfigured()).toBe(true);
        expect(await app.tokenFor('acme/app')).toBe('token-2');
    });

    describe('pull requests', () => {
        /** The installation endpoints, plus whatever `pulls` answers for the pull request calls. */
        const withPulls = (pulls: (url: string, init?: RequestInit) => Response) => {
            const calls: { url: string; method: string; body?: unknown; bearer: string }[] = [];
            const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
                const href = String(url);
                calls.push({
                    url: href,
                    method: init?.method ?? 'GET',
                    body: init?.body ? JSON.parse(String(init.body)) : undefined,
                    bearer: bearer(init),
                });
                if (href.endsWith('/repos/acme/app/installation')) return json(200, { id: 7 });
                if (href.endsWith('/access_tokens'))
                    return json(201, { token: 'install-token', expires_at: DateTime.now().plus({ hours: 1 }).toISO() });
                return pulls(href, init);
            }) as unknown as typeof fetch;
            return { fetchImpl, calls };
        };
        const draft = { head: 'card/0042', base: 'main', title: '0042: Do a thing', body: 'Goal' };

        it('opens one as the installation and says where it is', async () => {
            const { fetchImpl, calls } = withPulls(() => json(201, { number: 12, html_url: 'https://github.com/acme/app/pull/12', state: 'open' }));

            const pr = await new GitHubApp(identity(), fetchImpl).openPullRequest('acme/app', draft);

            expect(pr).toEqual({ number: 12, url: 'https://github.com/acme/app/pull/12', state: 'open' });
            const open = calls.find(call => call.url.endsWith('/repos/acme/app/pulls'))!;
            expect(open).toMatchObject({ method: 'POST', body: draft, bearer: 'install-token' });
        });

        it('returns the open one for that branch when GitHub says it already exists', async () => {
            const { fetchImpl, calls } = withPulls((url, init) =>
                init?.method === 'POST'
                    ? json(422, { message: 'Validation Failed' })
                    : json(200, [{ number: 9, html_url: 'https://github.com/acme/app/pull/9', state: 'open' }]),
            );

            const pr = await new GitHubApp(identity(), fetchImpl).openPullRequest('acme/app', draft);

            expect(pr.number).toBe(9);
            expect(calls.at(-1)!.url).toContain('head=acme%3Acard%2F0042');
            expect(calls.at(-1)!.url).toContain('state=open');
        });

        it('names the missing permission when GitHub forbids it', async () => {
            const { fetchImpl } = withPulls(() => json(403, { message: 'Resource not accessible by integration' }));

            await expect(new GitHubApp(identity(), fetchImpl).openPullRequest('acme/app', draft)).rejects.toMatchObject({
                statusCode: 503,
                details: { reason: expect.stringContaining('Pull requests write permission') },
            });
        });

        it('reads a merged one as merged, with the commit it made', async () => {
            const { fetchImpl } = withPulls(() =>
                json(200, { number: 12, html_url: 'u', state: 'closed', merged: true, merge_commit_sha: 'abc123' }),
            );

            expect(await new GitHubApp(identity(), fetchImpl).pullRequest('acme/app', 12)).toEqual({
                number: 12,
                url: 'u',
                state: 'merged',
                mergeCommitSha: 'abc123',
            });
        });

        it('reads one closed without merging as closed', async () => {
            const { fetchImpl } = withPulls(() => json(200, { number: 12, html_url: 'u', state: 'closed', merged: false, merge_commit_sha: 'abc' }));

            expect(await new GitHubApp(identity(), fetchImpl).pullRequest('acme/app', 12)).toEqual({ number: 12, url: 'u', state: 'closed' });
        });
    });
});
