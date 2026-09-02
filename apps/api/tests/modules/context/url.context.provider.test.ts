import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { UrlContextProvider } from '#modules/context/url.context.provider.js';
import { checkWebhookDestination } from '#modules/notify/webhook.destination.js';

// `checkWebhookDestination` calls `dns.promises.lookup` for real. Wrapping (not replacing) it keeps
// every test below fast and network-free: a literal IP address resolves through the real
// implementation instantly (no socket, no query — `getaddrinfo` short-circuits on a numeric host).
vi.mock('node:dns/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:dns/promises')>();
    return { ...actual, lookup: vi.fn(actual.lookup) };
});

/**
 * A `ReadableStream` that keeps producing chunks forever until `cancel()` is called — a stand-in for
 * an arbitrarily large (or literally endless) response body. If `UrlContextProvider` ever regressed
 * to reading a body fully before checking its size, a test built on this would hang instead of
 * failing fast, which is exactly the property the "bounded, while reading" acceptance criterion is
 * asking for.
 */
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

/** A `fetchImpl` that never settles on its own — it only rejects once its `AbortSignal` fires,
 * the same way the real `fetch` behaves when a request is aborted mid-flight. */
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

/**
 * Card 0186's Task 4: refusal paths run against the real `checkWebhookDestination`, not a stub — the
 * point is that this provider actually reuses card 0107's check rather than reimplementing it, and a
 * mocked check couldn't prove that.
 */
describe('UrlContextProvider, refusal paths (real checkWebhookDestination)', () => {
    it.each([
        ['http://example.com/doc', 'https'],
        ['https://127.0.0.1/doc', 'loopback'],
        ['https://169.254.169.254/doc', 'link-local'],
        ['https://10.1.2.3/doc', 'private'],
        ['this is not a url', 'valid URL'],
    ])('refuses %s without ever calling fetchImpl', async (url, expectedInReason) => {
        const fetchImpl = vi.fn();
        const provider = new UrlContextProvider(checkWebhookDestination, fetchImpl as unknown as typeof fetch);

        const result = await provider.fetch(url);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain(expectedInReason);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

/**
 * Normalisation and bounds, against an injected stub `fetchImpl` — the real `checkWebhookDestination`
 * refuses loopback, so these can't run against a real local server. `checkDestination` here is a
 * fixed `{ ok: true }` stub, isolating these tests from DNS/the real check entirely.
 */
describe('UrlContextProvider, normalisation and bounds (stubbed fetch)', () => {
    const allow = async () => ({ ok: true as const });

    it('refuses a redirect response rather than following it', async () => {
        const opaqueRedirect = { type: 'opaqueredirect', ok: false, status: 0 } as unknown as Response;
        const fetchImpl = vi.fn(async () => opaqueRedirect);
        const provider = new UrlContextProvider(allow, fetchImpl);

        const result = await provider.fetch('https://example.com/doc');

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('redirect');
    });

    it('refuses a non-2xx response, naming the status', async () => {
        const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
        const provider = new UrlContextProvider(allow, fetchImpl);

        const result = await provider.fetch('https://example.com/doc');

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('404');
    });

    it('abandons a hung response at the timeout instead of hanging the caller', async () => {
        const provider = new UrlContextProvider(allow, hangingFetch(), 20);

        const result = await provider.fetch('https://example.com/doc');

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('timed out');
    });

    it('refuses a body exceeding the cap without reading it fully into memory', async () => {
        const { stream, cancelled } = unboundedStream(1_000);
        const fetchImpl = vi.fn(async () => new Response(stream));
        const provider = new UrlContextProvider(allow, fetchImpl, 15_000, 2_500);

        const result = await provider.fetch('https://example.com/doc');

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('2500');
        expect(cancelled()).toBe(true);
    });

    it('returns content, a sha256 contentHash, and fetchedAt on a successful fetch', async () => {
        const fetchImpl = vi.fn(async () => new Response('  hello, context  '));
        const provider = new UrlContextProvider(allow, fetchImpl);

        const before = Date.now();
        const result = await provider.fetch('https://example.com/doc');
        const after = Date.now();

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.content).toBe('hello, context');
        expect(result.contentHash).toBe(createHash('sha256').update('hello, context', 'utf8').digest('hex'));
        expect(result.fetchedAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(result.fetchedAt.getTime()).toBeLessThanOrEqual(after);
    });
});

describe('UrlContextProvider.canHandle', () => {
    const provider = new UrlContextProvider();

    it('accepts an https URL', () => {
        expect(provider.canHandle('https://example.com/doc')).toBe(true);
    });

    it('rejects an http URL', () => {
        expect(provider.canHandle('http://example.com/doc')).toBe(false);
    });

    it('rejects a string that does not parse as a URL', () => {
        expect(provider.canHandle('not a url')).toBe(false);
    });
});
