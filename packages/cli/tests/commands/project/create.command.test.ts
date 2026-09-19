import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Card 0171. `wilson project create` ([[0168]]) is the command that exposed the gap this card
// closes: its `run` is `withApi(handler)` (`packages/cli/src/api-client.ts`), which builds a real
// `WilsonSdk` from `ctx.config` and calls the handler with it. Rather than mocking `withApi` or
// `apiClient` — both close over each other from inside the same module, so replacing one without
// the other intercepts nothing — this stubs the one seam underneath all of it: `global.fetch`,
// exactly what `createSdkFetch` (`packages/sdk/src/sdk-options.ts`) calls. Same house pattern as
// `apps/web/tests/sdk.test.ts:24` and `apps/api/tests/cli/sdk-fetch.helper.ts`.
const { default: command } = await import('#src/commands/project/create.command.js');

interface CreateOpts {
    codeRoot: string;
    worktreeRoot: string;
    runRoot: string;
}

type Handler<Opts> = (opts: Opts, ctx: unknown, args: unknown[]) => Promise<number | void>;

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

/**
 * The shape `httpError(...).withDetails({ reason })` sends over the wire — `describeApiError`
 * (`packages/cli/src/api-client.ts`) reads `body.details.reason` off exactly this, so a refusal
 * prints the operator-facing sentence rather than "Request failed with status 409".
 */
const reasonResponse = (status: number, reason: string): Response => jsonResponse({ details: { reason } }, status);

/**
 * A `ctx` good enough for `apiClient(ctx)`: `fetch` is stubbed, so the exact base URL is moot.
 * Card 0247: `apiClient` reads `ctx.env` (via `apiSettings`), not `ctx.config` any more, so `env`
 * must exist here even though every value in it is unset.
 */
const buildCtx = () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const config = { get: (_key: string, fallback: string) => fallback };
    return { ctx: { config, env: {}, logger }, logger };
};

const opts: CreateOpts = {
    codeRoot: '/repo/code',
    worktreeRoot: '/repo/worktrees',
    runRoot: '/repo/run',
};

const run = (ctx: unknown, name: string) => (command.run as unknown as Handler<CreateOpts>)(opts, ctx, [name]);

describe('wilson project create', () => {
    it('sends POST /api/projects carrying the name and the three paths, and reports success', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ name: 'acme' }));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, 'acme');

        expect(result).toBe(0);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/api/projects');
        expect(init.method).toBe('POST');
        const sent = JSON.parse(init.body as string);
        expect(sent).toEqual({
            name: 'acme',
            codeRoot: opts.codeRoot,
            worktreeRoot: opts.worktreeRoot,
            runRoot: opts.runRoot,
        });
        expect(logger.info).toHaveBeenCalledWith('acme registered');
    });

    it('surfaces the server refusal reason rather than a generic status message', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(409, 'acme is already registered'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, 'acme');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('acme is already registered');
    });
});
