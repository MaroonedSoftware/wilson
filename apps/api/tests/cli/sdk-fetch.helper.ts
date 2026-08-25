import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Shared test plumbing for the CLI commands card 0078 ported to `@wilson/sdk`.
 *
 * Every ported command's `run` is `withApi(handler)` (`packages/cli/src/api-client.ts`): it builds a
 * real `WilsonSdk` from `ctx.config` and calls the handler with it. Rather than mocking `withApi` or
 * `apiClient` themselves — both close over each other from inside the same module, so replacing one
 * without the other does not actually intercept anything — these tests stub the one seam underneath
 * all of it: `global.fetch`, which is exactly what `createSdkFetch` (`packages/sdk/src/sdk-options.ts`)
 * calls. That exercises the command, `withApi`'s error handling, and the SDK's request/response
 * shaping together, the same as they run in production, with only the network replaced.
 */

export type FetchMock = ReturnType<typeof vi.fn>;

export let fetchMock: FetchMock;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** A JSON success response shaped the way `parseJson` in `packages/sdk/src/sdk-options.ts` expects. */
export const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The shape `httpError(...).withDetails({ reason })` sends over the wire (card 0080) — the CLI's
 * `describeApiError` reads `body.details.reason` off exactly this, so an operator sees "0072 is not
 * flagged for a human" rather than "Request failed with status 400".
 */
export const reasonResponse = (status: number, reason: string): Response => jsonResponse({ details: { reason } }, status);

/** The real shape of a `fetch` that never reached a server — a refused or absent connection. */
export const connectionRefused = (): Promise<never> => Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));

/**
 * A `ctx` good enough for `apiClient(ctx)`: `resolveApiBase` reads `API_URL`/`PORT` off it and falls
 * back to `http://localhost:13100` when neither is set. The exact base is irrelevant here since
 * `fetch` itself is stubbed — these tests assert on the path each call was made with, not the host.
 */
export const buildCtx = () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const config = { get: (_key: string, fallback: string) => fallback };
    return { ctx: { config, logger }, logger };
};

export type Handler<Opts = unknown> = (opts: Opts, ctx: unknown, args: unknown[]) => Promise<number | void>;

/** The URL a mocked fetch call was made with — call args are `[url, init]`. */
export const urlOf = (call: unknown[]): string => call[0] as string;

/** The HTTP method a mocked fetch call was made with. */
export const methodOf = (call: unknown[]): string | undefined => (call[1] as { method?: string } | undefined)?.method;
