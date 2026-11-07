import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createToolGuard, qualifiedGithubTool, subscriptionEnv } from '#modules/agent/cli.stage.agent.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import {
    checkGithubUrl,
    fetchGithub,
    GITHUB_TOOL,
    GithubToolInputSchema,
    readGithub,
    webAccessOf,
    type GithubFetchOptions,
} from '#modules/agent/tools/github.tool.js';
import { buildTools, type ToolContext } from '#modules/agent/tools/index.js';

/**
 * Card 0013: the GitHub read tool, against a local HTTP server standing in for GitHub. The tool only
 * ever builds `https://<github host>/...` URLs, so the fetch it is given rewrites each one to the
 * local server, keeping the host as the first path segment, and the server answers by host and path.
 * Nothing here touches the real network.
 */
interface Seen {
    method: string;
    host: string;
    path: string;
    headers: IncomingHttpHeaders;
}

let server: Server;
let origin: string;
const seen: Seen[] = [];

type Route = (res: import('node:http').ServerResponse) => void;
const routes = new Map<string, Route>();

beforeAll(async () => {
    server = createServer((req, res) => {
        const [, host = '', ...rest] = (req.url ?? '/').split('/');
        const path = `/${rest.join('/')}`;
        seen.push({ method: req.method ?? '', host, path, headers: req.headers });
        const route = routes.get(`${host}${path}`);
        if (!route) {
            res.writeHead(404).end('Not Found');
            return;
        }
        route(res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
    seen.length = 0;
    routes.clear();
});

/** A fetch that sends `https://<host>/<path>` to the local server as `/<host>/<path>`, everything else untouched. */
const local: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    return fetch(`${origin}/${url.hostname}${url.pathname}${url.search}`, init);
};
const options = (over: GithubFetchOptions = {}): GithubFetchOptions => ({ fetch: local, ...over });

const text =
    (body: string, type = 'text/plain; charset=utf-8', status = 200, headers: Record<string, string> = {}): Route =>
    res => {
        res.writeHead(status, { 'content-type': type, ...headers }).end(body);
    };
const redirect =
    (location: string, status = 302): Route =>
    res => {
        res.writeHead(status, { location }).end();
    };

const makeContext = () => {
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const context = {
        project: 'p',
        cardId: '0013',
        stage: 'implementing',
        worktreeRoot: '/tmp',
        scope: new ScopeGuard({ worktreeRoot: '/tmp', allow: ['src/**'], alwaysAllowed: [] }),
        commands: new CommandAllowlist(['pnpm build']),
        scopeViolationPolicy: 'widen' as const,
        events: {
            append: async (e: { type: string; payload?: Record<string, unknown> }) => {
                events.push({ type: e.type, payload: e.payload ?? {} });
            },
        },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as ToolContext;
    return { context, events };
};

describe('fetchGithub', () => {
    it('AC2: reads a file from raw.githubusercontent.com, with the URL and HTTP status', async () => {
        routes.set('raw.githubusercontent.com/o/r/main/README.md', text('# Hello\n'));

        const outcome = await fetchGithub('https://raw.githubusercontent.com/o/r/main/README.md', options());

        expect(outcome.ok).toBe(true);
        expect(outcome.text).toBe('https://raw.githubusercontent.com/o/r/main/README.md\nHTTP 200\n\n# Hello\n');
    });

    it('AC2: reads a listing from api.github.com', async () => {
        const listing = JSON.stringify([{ name: 'src', type: 'dir' }]);
        routes.set('api.github.com/repos/o/r/contents/', text(listing, 'application/json; charset=utf-8'));

        const outcome = await fetchGithub('https://api.github.com/repos/o/r/contents/', options());

        expect(outcome.ok).toBe(true);
        expect(outcome.text).toContain('HTTP 200');
        expect(outcome.text).toContain(listing);
    });

    it.each([
        ['another host', 'https://example.com/file'],
        ['a lookalike subdomain', 'https://raw.githubusercontent.com.evil.example/x'],
        ['a subdomain of github.com', 'https://gist.github.com/x'],
        ['http', 'http://raw.githubusercontent.com/o/r/main/README.md'],
        ['a file URL', 'file:///etc/passwd'],
        ['a non-default port', 'https://github.com:8443/o/r'],
        ['credentials in the URL', 'https://user:pass@github.com/o/r'],
        ['not a URL', 'raw.githubusercontent.com/o/r'],
    ])('AC3: refuses %s with a reason, and sends nothing', async (_label, url) => {
        const outcome = await fetchGithub(url, options());

        expect(outcome.ok).toBe(false);
        expect(outcome.denied).toBe(true);
        expect(outcome.text).toMatch(/^error: .+/);
        expect(seen).toHaveLength(0);
    });

    it('AC3: refuses a redirect off the allowed hosts without following it', async () => {
        routes.set('github.com/o/r/raw/main/x', redirect('https://evil.example/steal'));

        const outcome = await fetchGithub('https://github.com/o/r/raw/main/x', options());

        expect(outcome.ok).toBe(false);
        expect(outcome.denied).toBe(true);
        expect(outcome.text).toMatch(/redirects to https:\/\/evil\.example\/steal, which was not followed/);
        expect(seen.map(s => s.host)).toEqual(['github.com']);
    });

    it('AC3: refuses a redirect to http on an allowed host', async () => {
        routes.set('github.com/o/r/raw/main/x', redirect('http://raw.githubusercontent.com/o/r/main/x'));

        const outcome = await fetchGithub('https://github.com/o/r/raw/main/x', options());

        expect(outcome.denied).toBe(true);
        expect(outcome.text).toMatch(/only https/);
        expect(seen).toHaveLength(1);
    });

    it('follows a redirect that stays on the allowed hosts', async () => {
        routes.set('github.com/o/r/raw/main/x', redirect('https://raw.githubusercontent.com/o/r/main/x'));
        routes.set('raw.githubusercontent.com/o/r/main/x', text('content'));

        const outcome = await fetchGithub('https://github.com/o/r/raw/main/x', options());

        expect(outcome.ok).toBe(true);
        expect(outcome.url).toBe('https://raw.githubusercontent.com/o/r/main/x');
        expect(outcome.text).toContain('content');
        expect(seen.map(s => s.host)).toEqual(['github.com', 'raw.githubusercontent.com']);
    });

    it('resolves a relative redirect against the URL it came from', async () => {
        routes.set('api.github.com/repos/o/old', redirect('/repos/o/new', 301));
        routes.set('api.github.com/repos/o/new', text('{"name":"new"}', 'application/json'));

        const outcome = await fetchGithub('https://api.github.com/repos/o/old', options());

        expect(outcome.ok).toBe(true);
        expect(outcome.url).toBe('https://api.github.com/repos/o/new');
        expect(outcome.text).toBe('https://api.github.com/repos/o/new\nHTTP 200\n\n{"name":"new"}');
    });

    it('stops a redirect loop on the allowed hosts after a few hops, with a reason', async () => {
        routes.set('github.com/a', redirect('https://github.com/b'));
        routes.set('github.com/b', redirect('https://github.com/a'));

        const outcome = await fetchGithub('https://github.com/a', options());

        expect(outcome.ok).toBe(false);
        expect(outcome.text).toMatch(/^error: more than \d+ redirects/);
        expect(seen.length).toBeLessThanOrEqual(5);
    });

    it('refuses a redirect with no Location, with a reason', async () => {
        routes.set('github.com/o/r', res => {
            res.writeHead(302).end();
        });

        const outcome = await fetchGithub('https://github.com/o/r', options());

        expect(outcome.ok).toBe(false);
        expect(outcome.status).toBe(302);
        expect(outcome.text).toMatch(/nowhere to go/);
    });

    it('AC12: a 403 with no reset header still says the limit was reached, after one request', async () => {
        routes.set('api.github.com/x', text('forbidden', 'text/plain', 403));

        const outcome = await fetchGithub('https://api.github.com/x', options());

        expect(outcome.status).toBe(403);
        expect(outcome.text).toMatch(/rate limit .* was reached/);
        expect(outcome.text).not.toMatch(/It resets/);
        expect(seen).toHaveLength(1);
    });

    it('AC5: cuts a response over the size cap, and says so', async () => {
        routes.set('raw.githubusercontent.com/o/r/main/big.txt', text('a'.repeat(5000)));

        const outcome = await fetchGithub('https://raw.githubusercontent.com/o/r/main/big.txt', options({ maxBytes: 1000 }));

        expect(outcome.reason).toBe('cut at 1000 bytes');
        expect(outcome.text).toContain(`${'a'.repeat(1000)}\n\n[cut at 1000 bytes: the response was longer]`);
        expect(outcome.text).not.toContain('a'.repeat(1001));
    });

    it('AC5: refuses a binary content type', async () => {
        routes.set('raw.githubusercontent.com/o/r/main/logo.png', text('\x89PNG', 'image/png'));

        const outcome = await fetchGithub('https://raw.githubusercontent.com/o/r/main/logo.png', options());

        expect(outcome.ok).toBe(false);
        expect(outcome.text).toMatch(/image\/png, not text, and binary content is not read/);
    });

    it('AC5: refuses a body holding NUL bytes even when it claims to be text', async () => {
        routes.set('raw.githubusercontent.com/o/r/main/blob', res => {
            res.writeHead(200, { 'content-type': 'text/plain' }).end(Buffer.from([0x41, 0x00, 0x42]));
        });

        const outcome = await fetchGithub('https://raw.githubusercontent.com/o/r/main/blob', options());

        expect(outcome.ok).toBe(false);
        expect(outcome.text).toMatch(/binary content/);
    });

    it('AC5: stops a request over the time limit, with a reason', async () => {
        routes.set('raw.githubusercontent.com/o/r/main/slow', res => {
            setTimeout(() => res.writeHead(200, { 'content-type': 'text/plain' }).end('late'), 2000).unref();
        });

        const outcome = await fetchGithub('https://raw.githubusercontent.com/o/r/main/slow', options({ timeoutMs: 100 }));

        expect(outcome.ok).toBe(false);
        expect(outcome.text).toMatch(/took longer than 100 ms and was stopped/);
    });

    it('AC6, AC11: sends a GET with no Authorization header, whatever the environment holds', async () => {
        const saved = process.env.GITHUB_TOKEN;
        process.env.GITHUB_TOKEN = 'ghp_secret';
        try {
            routes.set('raw.githubusercontent.com/o/r/main/a', text('a'));
            routes.set('api.github.com/repos/o/r', text('{}', 'application/json'));

            await fetchGithub('https://raw.githubusercontent.com/o/r/main/a', options());
            await fetchGithub('https://api.github.com/repos/o/r', options());

            expect(seen).toHaveLength(2);
            for (const request of seen) {
                expect(request.method).toBe('GET');
                expect(request.headers.authorization).toBeUndefined();
                expect(JSON.stringify(request.headers)).not.toContain('ghp_secret');
            }
        } finally {
            if (saved === undefined) delete process.env.GITHUB_TOKEN;
            else process.env.GITHUB_TOKEN = saved;
        }
    });

    it('AC6: GITHUB_TOKEN is absent from the engine environment', () => {
        const saved = process.env.GITHUB_TOKEN;
        process.env.GITHUB_TOKEN = 'ghp_secret';
        try {
            expect(subscriptionEnv().GITHUB_TOKEN).toBeUndefined();
        } finally {
            if (saved === undefined) delete process.env.GITHUB_TOKEN;
            else process.env.GITHUB_TOKEN = saved;
        }
    });

    it.each([403, 429])('AC12: a %i says the rate limit was reached and when it resets, after one request', async status => {
        const body = '{"message":"API rate limit exceeded"}';
        routes.set('api.github.com/repos/o/r/contents/', text(body, 'application/json', status, { 'x-ratelimit-reset': '1800000000' }));

        const outcome = await fetchGithub('https://api.github.com/repos/o/r/contents/', options());

        expect(outcome.ok).toBe(false);
        expect(outcome.text).toContain(`HTTP ${status}`);
        expect(outcome.text).toMatch(/rate limit .* was reached/);
        expect(outcome.text).toContain(`It resets at ${new Date(1_800_000_000 * 1000).toISOString()}.`);
        expect(outcome.text).toMatch(/not retried/);
        expect(seen).toHaveLength(1);
    });

    it('AC12: says when a 429 resets from retry-after', async () => {
        routes.set('api.github.com/x', text('slow down', 'text/plain', 429, { 'retry-after': '60' }));

        const outcome = await fetchGithub('https://api.github.com/x', options());

        expect(outcome.text).toContain('It resets in 60 seconds.');
        expect(seen).toHaveLength(1);
    });

    it('reads a private or missing repository as not found', async () => {
        const outcome = await fetchGithub('https://raw.githubusercontent.com/o/private/main/x', options());

        expect(outcome.ok).toBe(false);
        expect(outcome.status).toBe(404);
        expect(outcome.text).toMatch(/not found/);
    });
});

describe('the tool input', () => {
    it('AC11: is a URL and nothing else — no method, header or body', () => {
        expect(Object.keys(GithubToolInputSchema.shape)).toEqual(['url']);
        expect(GithubToolInputSchema.strict().safeParse({ url: 'https://github.com/o/r', method: 'POST' }).success).toBe(false);
    });
});

describe('readGithub', () => {
    it('AC8: records a read as tool.executed with the URL and status', async () => {
        routes.set('raw.githubusercontent.com/o/r/main/a', text('a'));
        const { context, events } = makeContext();

        await readGithub(context, 'https://raw.githubusercontent.com/o/r/main/a', options());

        expect(events).toEqual([
            { type: 'tool.executed', payload: { tool: GITHUB_TOOL, url: 'https://raw.githubusercontent.com/o/r/main/a', status: 200 } },
        ]);
    });

    it('AC8: records a refused URL as tool.denied with the URL and reason', async () => {
        const { context, events } = makeContext();

        const reply = await readGithub(context, 'https://example.com/x', options());

        expect(reply).toMatch(/^error: example\.com is not a GitHub host/);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'tool.denied', payload: { tool: GITHUB_TOOL, url: 'https://example.com/x' } });
    });

    it('AC8: records a redirect off the hosts as tool.denied with the URL', async () => {
        routes.set('github.com/o/r', redirect('https://evil.example/'));
        const { context, events } = makeContext();

        await readGithub(context, 'https://github.com/o/r', options());

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'tool.denied', payload: { tool: GITHUB_TOOL, url: 'https://github.com/o/r', status: 302 } });
    });
});

describe('checkGithubUrl', () => {
    it.each(['https://github.com/o/r', 'https://api.github.com/repos/o/r', 'https://raw.githubusercontent.com/o/r/main/x'])('allows %s', url => {
        expect(checkGithubUrl(url).allowed).toBe(true);
    });
});

describe('webAccessOf', () => {
    it('AC1: reads a missing value as none', () => {
        expect(webAccessOf({})).toBe('none');
        expect(webAccessOf({ webAccess: 'github' })).toBe('github');
    });
});

describe('createToolGuard and the GitHub tool', () => {
    const opts = { signal: new AbortController().signal } as never;
    const guardAt = (webAccess?: 'none' | 'github' | 'web') => {
        const { context, events } = makeContext();
        return { guard: createToolGuard(context, 'rw', undefined, undefined, undefined, webAccess), events };
    };
    const url = 'https://raw.githubusercontent.com/o/r/main/README.md';

    it.each([undefined, 'none'] as const)('AC1: refuses the tool at %s, as not available to this stage, recording the URL', async webAccess => {
        const { guard, events } = guardAt(webAccess);

        const decision = await guard(qualifiedGithubTool(), { url }, opts);

        expect(decision).toEqual({ behavior: 'deny', message: `${qualifiedGithubTool()} is not available to this stage` });
        expect(events).toEqual([
            { type: 'tool.denied', payload: { tool: qualifiedGithubTool(), reason: `${qualifiedGithubTool()} is not available to this stage`, url } },
        ]);
    });

    it.each([undefined, 'none', 'github', 'web'] as const)('AC1, AC4: still refuses WebFetch and WebSearch at %s', async webAccess => {
        const { guard } = guardAt(webAccess);

        await expect(guard('WebFetch', { url, prompt: 'x' }, opts)).resolves.toEqual({
            behavior: 'deny',
            message: 'WebFetch is not available to this stage',
        });
        await expect(guard('WebSearch', { query: 'x' }, opts)).resolves.toEqual({
            behavior: 'deny',
            message: 'WebSearch is not available to this stage',
        });
    });

    it.each(['github', 'web'] as const)('allows the tool at %s, by its qualified and bare names', async webAccess => {
        const { guard } = guardAt(webAccess);

        await expect(guard(qualifiedGithubTool(), { url }, opts)).resolves.toEqual({ behavior: 'allow' });
        await expect(guard(GITHUB_TOOL, { url }, opts)).resolves.toEqual({ behavior: 'allow' });
    });

    it.each(['https://example.com/x', 'http://github.com/o/r'])('AC3: refuses %s at github, recording the URL', async bad => {
        const { guard, events } = guardAt('github');

        const decision = await guard(qualifiedGithubTool(), { url: bad }, opts);

        expect(decision).toMatchObject({ behavior: 'deny' });
        expect(events[0]).toMatchObject({ type: 'tool.denied', payload: { url: bad } });
    });
});

describe('buildTools and the GitHub tool', () => {
    const schema = z.object({ summary: z.string() });

    it.each([undefined, 'none'] as const)('AC10: the api adapter has no GitHub tool at %s', webAccess => {
        const { context } = makeContext();
        expect(Object.keys(buildTools(context, schema, 'rw', false, webAccess))).not.toContain(GITHUB_TOOL);
    });

    it.each(['github', 'web'] as const)('AC10: the api adapter has the GitHub tool at %s', webAccess => {
        const { context } = makeContext();
        expect(Object.keys(buildTools(context, schema, 'readonly', false, webAccess))).toContain(GITHUB_TOOL);
    });

    it('AC4: the api adapter has no web tool of any other kind at github', () => {
        const { context } = makeContext();
        const names = Object.keys(buildTools(context, schema, 'rw', true, 'github'));
        expect(names.filter(name => /web/i.test(name))).toEqual([]);
    });
});
