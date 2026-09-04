import { describe, expect, it, vi } from 'vitest';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import { GitHubIssuesSource } from '#modules/sources/github.issues.source.js';

/** A `SettingsStore` fake keyed by `definition.key`, values not named falling through to the
 * definition's own coded default — the same idiom `source.poller.test.ts`'s `fakeSettingsStore`
 * uses, simplified to one project since `GitHubIssuesSource` never reads `BoardConfig` itself. */
const fakeSettings = (values: Record<string, unknown> = {}): SettingsStore =>
    ({
        get: vi.fn(async (definition: { key: string; defaultValue: unknown }) => (definition.key in values ? values[definition.key] : definition.defaultValue)),
    }) as unknown as SettingsStore;

const withRepo = (repo = 'octocat/hello-world', label?: string): SettingsStore =>
    fakeSettings({ 'github-repo': repo, ...(label !== undefined ? { 'github-label': label } : {}) });

type FetchCall = { url: string; init: RequestInit };

/** Records every call `fetchImpl` receives and hands back a queued sequence of `Response`s (the
 * last repeats once exhausted) — enough to script a multi-page fetch without a real network. */
const scriptedFetch = (responses: Response[]): { fetchImpl: typeof fetch; calls: FetchCall[] } => {
    const calls: FetchCall[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const response = responses[Math.min(call, responses.length - 1)]!;
        call += 1;
        return response;
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
};

const jsonResponse = (body: unknown, init: ResponseInit & { link?: string } = {}): Response => {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    if (init.link) headers.set('link', init.link);
    return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
};

/** A `ReadableStream` that keeps producing chunks forever until `cancel()` is called — proves the
 * size cap is enforced while reading, not after (`UrlContextProvider`'s own test for the same
 * property, `url.context.provider.test.ts`). */
function unboundedStream(chunkBytes: number): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
    let cancelled = false;
    const chunk = new Uint8Array(chunkBytes).fill(97);
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (cancelled) return;
            controller.enqueue(chunk);
        },
        cancel() {
            cancelled = true;
        },
    });
    return { stream, cancelled: () => cancelled };
}

/** A `fetchImpl` that never settles on its own — only rejects once its `AbortSignal` fires, the same
 * way the real `fetch` behaves when a request is aborted mid-flight. */
function hangingFetch(): typeof fetch {
    return vi.fn((_url: string | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                const error = new Error('The operation was aborted');
                error.name = 'AbortError';
                reject(error);
            });
        });
    }) as unknown as typeof fetch;
}

const issue = (overrides: Partial<{ number: number; title: string; body: string | null; updated_at: string; pull_request: unknown }> = {}) => ({
    number: 1,
    title: 'Fix the thing',
    body: 'It is broken.',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
});

describe('GitHubIssuesSource.name', () => {
    it('is "github" — the key its refs are stored under in cards.external', () => {
        const source = new GitHubIssuesSource(withRepo(), 'tok');
        expect(source.name).toBe('github');
    });
});

describe('GitHubIssuesSource.changedSince — mapping', () => {
    it('maps a labelled issue to a CardSourceItem with externalId "owner/repo#123" and byte-for-byte title/body', async () => {
        const { fetchImpl } = scriptedFetch([jsonResponse([issue({ number: 123, title: 'Widget is broken', body: 'Steps to reproduce...' })])]);
        const source = new GitHubIssuesSource(withRepo('octocat/hello-world'), 'tok', fetchImpl);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.items).toEqual([
            { externalId: 'octocat/hello-world#123', title: 'Widget is broken', body: 'Steps to reproduce...', version: '2026-01-01T00:00:00Z' },
        ]);
    });

    /**
     * Card 0197: `version` is what lets `InboundCardWriter` tell a genuine edit from a pure
     * redelivery — GitHub bumps `updated_at` on every edit and holds it fixed on a redelivery, so
     * this source hands it straight through rather than computing anything of its own.
     */
    it("maps an issue's updated_at to the item's version, verbatim", async () => {
        const { fetchImpl } = scriptedFetch([jsonResponse([issue({ updated_at: '2026-03-14T09:26:00Z' })])]);
        const source = new GitHubIssuesSource(withRepo(), 'tok', fetchImpl);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.items[0]!.version).toBe('2026-03-14T09:26:00Z');
    });

    it('falls back to an empty body when GitHub reports null', async () => {
        const { fetchImpl } = scriptedFetch([jsonResponse([issue({ body: null })])]);
        const source = new GitHubIssuesSource(withRepo(), 'tok', fetchImpl);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.items[0]!.body).toBe('');
    });

    it('does not return a pull request in the same response', async () => {
        const pr = issue({ number: 2, title: 'A pull request', pull_request: { url: 'https://api.github.com/...' } });
        const { fetchImpl } = scriptedFetch([jsonResponse([issue({ number: 1 }), pr])]);
        const source = new GitHubIssuesSource(withRepo(), 'tok', fetchImpl);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.items).toHaveLength(1);
        expect(result.items[0]!.externalId).toContain('#1');
    });

    it('requests the documented query: labels, state=open, sort=updated, direction=asc, per_page=100, and since when a cursor is given', async () => {
        const { fetchImpl, calls } = scriptedFetch([jsonResponse([])]);
        const source = new GitHubIssuesSource(withRepo('octocat/hello-world', 'wilson-import'), 'tok', fetchImpl);

        await source.changedSince('2026-01-01T00:00:00Z');

        const url = new URL(calls[0]!.url);
        expect(url.pathname).toBe('/repos/octocat/hello-world/issues');
        expect(url.searchParams.get('labels')).toBe('wilson-import');
        expect(url.searchParams.get('state')).toBe('open');
        expect(url.searchParams.get('sort')).toBe('updated');
        expect(url.searchParams.get('direction')).toBe('asc');
        expect(url.searchParams.get('per_page')).toBe('100');
        expect(url.searchParams.get('since')).toBe('2026-01-01T00:00:00Z');
    });

    it('omits since entirely on the first-ever call (cursor undefined)', async () => {
        const { fetchImpl, calls } = scriptedFetch([jsonResponse([])]);
        const source = new GitHubIssuesSource(withRepo(), 'tok', fetchImpl);

        await source.changedSince(undefined);

        expect(new URL(calls[0]!.url).searchParams.has('since')).toBe(false);
    });
});

describe('GitHubIssuesSource.changedSince — cursor', () => {
    it('returns the maximum updated_at among reported issues as the next cursor', async () => {
        const { fetchImpl } = scriptedFetch([
            jsonResponse([issue({ number: 1, updated_at: '2026-01-01T00:00:00Z' }), issue({ number: 2, updated_at: '2026-01-03T00:00:00Z' }), issue({ number: 3, updated_at: '2026-01-02T00:00:00Z' })]),
        ]);
        const source = new GitHubIssuesSource(withRepo(), 'tok', fetchImpl);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.cursor).toBe('2026-01-03T00:00:00Z');
    });

    it('returns the incoming cursor unchanged when it reported no items', async () => {
        const { fetchImpl } = scriptedFetch([jsonResponse([])]);
        const source = new GitHubIssuesSource(withRepo(), 'tok', fetchImpl);

        const result = await source.changedSince('cursor-before');

        expect(result).toEqual({ ok: true, items: [], cursor: 'cursor-before' });
    });

    it('reports a string cursor even on a first-ever call that finds nothing', async () => {
        const { fetchImpl } = scriptedFetch([jsonResponse([])]);
        const source = new GitHubIssuesSource(withRepo(), 'tok', fetchImpl);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.cursor).toBe('');
    });
});

describe('GitHubIssuesSource.changedSince — repo validation', () => {
    it.each(['../../etc', 'https://evil/x', 'owner/name/extra'])('refuses repo %s with no request made', async repo => {
        const { fetchImpl } = scriptedFetch([jsonResponse([])]);
        const source = new GitHubIssuesSource(withRepo(repo), 'tok', fetchImpl);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses when GITHUB_REPO resolves to nothing configured', async () => {
        const source = new GitHubIssuesSource(fakeSettings(), 'tok');

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(false);
    });
});

describe('GitHubIssuesSource.changedSince — HTTP failures', () => {
    it.each([401, 403, 404])('a %s response produces { ok: false } naming that status, without throwing', async status => {
        const { fetchImpl } = scriptedFetch([new Response('nope', { status })]);
        const source = new GitHubIssuesSource(withRepo(), 'tok', fetchImpl);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain(String(status));
    });

    it('a timeout produces { ok: false } instead of hanging the caller', async () => {
        const source = new GitHubIssuesSource(withRepo(), 'tok', hangingFetch(), 20);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('timed out');
    });

    it('an unparseable body produces { ok: false } instead of throwing', async () => {
        const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
        const source = new GitHubIssuesSource(withRepo(), 'tok', fetchImpl);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(false);
    });

    it('a response larger than the size cap is refused while reading, not after', async () => {
        const { stream, cancelled } = unboundedStream(1_000);
        const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
        const source = new GitHubIssuesSource(withRepo(), 'tok', fetchImpl, 15_000, 2_500);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('2500');
        expect(cancelled()).toBe(true);
    });
});

describe('GitHubIssuesSource.changedSince — the token never leaks', () => {
    it('sends the token in the Authorization header, never in a refusal reason', async () => {
        const secret = 'ghp_super-secret-token';
        const { fetchImpl, calls } = scriptedFetch([new Response('unauthorized', { status: 401 })]);
        const source = new GitHubIssuesSource(withRepo(), secret, fetchImpl);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).not.toContain(secret);
        const headers = new Headers(calls[0]!.init.headers);
        expect(headers.get('authorization')).toBe(`Bearer ${secret}`);
    });
});

describe('GitHubIssuesSource.changedSince — pagination', () => {
    it('follows Link: rel="next" across more than one page', async () => {
        const page1 = jsonResponse([issue({ number: 1 })], { link: '<https://api.github.com/repos/octocat/hello-world/issues?page=2>; rel="next"' });
        const page2 = jsonResponse([issue({ number: 2 })]);
        const { fetchImpl, calls } = scriptedFetch([page1, page2]);
        const source = new GitHubIssuesSource(withRepo(), 'tok', fetchImpl);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.items.map(i => i.externalId)).toEqual(['octocat/hello-world#1', 'octocat/hello-world#2']);
        expect(calls).toHaveLength(2);
        expect(calls[1]!.url).toBe('https://api.github.com/repos/octocat/hello-world/issues?page=2');
    });

    it('stops following Link: rel="next" at the page cap even when GitHub keeps offering another', async () => {
        // A fresh `Response` per call, unlike `scriptedFetch`'s repeat-the-last-one semantics: a
        // `Response`'s body stream can only be read once, and this test's whole point is that
        // `fetchImpl` gets called many times over.
        const fetchImpl = vi.fn(
            async () => jsonResponse([issue()], { link: '<https://api.github.com/repos/octocat/hello-world/issues?page=next>; rel="next"' }),
        ) as unknown as typeof fetch;
        const source = new GitHubIssuesSource(withRepo(), 'tok', fetchImpl);

        const result = await source.changedSince(undefined);

        expect(result.ok).toBe(true);
        const callCount = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
        expect(callCount).toBeLessThanOrEqual(10);
        expect(callCount).toBeGreaterThan(1);
    });
});
