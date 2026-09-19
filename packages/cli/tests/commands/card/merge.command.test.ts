import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Card 0238. Same house pattern as `lint.command.test.ts`: `wilson card merge` is
// `withApi(handler)` (`packages/cli/src/api-client.ts`), so the one seam worth stubbing is
// `global.fetch` underneath the real `WilsonSdk` — not `withApi`/`apiClient` themselves, which
// close over each other from inside the same module.
const { default: command } = await import('#src/commands/card/merge.command.js');

type Handler = (opts: Record<string, unknown>, ctx: unknown, args: unknown[]) => Promise<number | void>;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** A JSON response shaped the way `parseJson` in `packages/sdk/src/sdk-options.ts` expects. */
const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A `ctx` good enough for `apiClient(ctx)`: `fetch` is stubbed, so the exact base URL is moot. */
const buildCtx = () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const config = { get: (_key: string, fallback: string) => fallback };
    return { ctx: { config, logger }, logger };
};

const run = (ctx: unknown, cardId: string) => (command.run as unknown as Handler)({}, ctx, [cardId]);

describe('wilson card merge', () => {
    it('posts to the merge endpoint and reports the landed commit, exiting 0 (AC7)', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ merged: true, commit: 'abc123def' }));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0090');

        expect(result).toBe(0);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/api/cards/0090/merge');
        expect(init.method).toBe('POST');
        expect(logger.info).toHaveBeenCalledWith('0090: merged as abc123def');
    });

    it('reports the reason and exits 1 when merged is false, without treating it as a request failure (AC7)', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                merged: false,
                reason: 're-review: main moved under src/index.ts since review (round 1 of 2)',
            }),
        );
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0101');

        expect(result).toBe(1);
        expect(logger.info).toHaveBeenCalledWith(
            '0101: not merged — re-review: main moved under src/index.ts since review (round 1 of 2)',
        );
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('surfaces the API error for an unknown card id, the way other commands do', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ details: { reason: '9999 does not exist' } }, 404));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '9999');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('9999 does not exist');
    });
});
