import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Card 0195. Same house pattern as `packages/cli/tests/commands/project/create.command.test.ts`:
// `wilson card lint` is `withApi(handler)` (`packages/cli/src/api-client.ts`), so the one seam
// worth stubbing is `global.fetch` underneath the real `WilsonSdk` — not `withApi`/`apiClient`
// themselves, which close over each other from inside the same module.
const { default: command } = await import('#src/commands/card/lint.command.js');

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

/**
 * The shape `httpError(...).withDetails({ reason })` sends over the wire — `describeApiError`
 * (`packages/cli/src/api-client.ts`) reads `body.details.reason` off exactly this, so a refusal
 * prints the operator-facing sentence rather than "Request failed with status 404".
 */
const reasonResponse = (status: number, reason: string): Response => jsonResponse({ details: { reason } }, status);

/** A `ctx` good enough for `apiClient(ctx)`: `fetch` is stubbed, so the exact base URL is moot. */
const buildCtx = () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const config = { get: (_key: string, fallback: string) => fallback };
    return { ctx: { config, logger }, logger };
};

const run = (ctx: unknown, cardId: string) => (command.run as unknown as Handler)({}, ctx, [cardId]);

describe('wilson card lint', () => {
    it('prints each finding with its kind and exits non-zero', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse([
                { kind: 'command', message: 'pnpm migrate:create is not on the implementing allowlist' },
                { kind: 'alwaysAllowed', message: 'git status is already covered by the project alwaysAllowed list' },
            ]),
        );
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0195');

        expect(result).toBe(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/api/cards/0195/lint');
        expect(init.method).toBe('GET');
        const printed = logger.info.mock.calls.map(call => call[0]).join('\n');
        expect(printed).toContain('[command] pnpm migrate:create is not on the implementing allowlist');
        expect(printed).toContain('[alwaysAllowed] git status is already covered by the project alwaysAllowed list');
    });

    it('says so and exits zero when there are no findings', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0195');

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith('0195: no findings');
    });

    it('surfaces the API error for an unknown card id, the way other commands do', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(404, '9999 does not exist'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '9999');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('9999 does not exist');
    });
});
