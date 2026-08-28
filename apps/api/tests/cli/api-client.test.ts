import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '@maroonedsoftware/appconfig';
// `@wilson/sdk` is not one of apps/api's own dependencies (only packages/cli and apps/web depend on
// it), so it is not resolvable as a bare specifier from a file living under apps/api/tests — reached
// by relative path into the package's source instead, the same way this suite already reaches into
// packages/cli by relative path rather than as an installed dependency.
import { createSdkFetch, SdkError } from '../../../../packages/sdk/src/sdk-options.js';
import { WilsonSdk } from '../../../../packages/sdk/src/wilson.sdk.js';
import { apiClient, describeApiError, resolveApiBase, resolveProject, withApi } from '../../../../packages/cli/src/api-client.js';

// Card 0078 introduces `api-client.ts`: the one place every ported command gets its `WilsonSdk` from,
// and the one place a failed API call becomes the message an operator should read. This file exercises
// that module directly, rather than only indirectly through every command that uses it — `resolveApiBase`
// (config → base URL), `describeApiError` (error → operator-facing string), and `withApi` (the wrapper
// that ties the two together and turns a throw into an exit code).
const buildCtx = (values: Record<string, string> = {}) => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { ctx: { config: new AppConfig(values), logger }, logger };
};

describe('resolveApiBase', () => {
    it('defaults to localhost on the well-known API port when nothing is configured', () => {
        expect(resolveApiBase(buildCtx().ctx)).toBe('http://localhost:13100');
    });

    it('uses PORT when set, the same config key apps/api binds to', () => {
        expect(resolveApiBase(buildCtx({ PORT: '4000' }).ctx)).toBe('http://localhost:4000');
    });

    it('prefers API_URL outright when set, for an API running elsewhere', () => {
        expect(resolveApiBase(buildCtx({ API_URL: 'https://api.example.com', PORT: '4000' }).ctx)).toBe('https://api.example.com');
    });

    it('trims a trailing slash off API_URL so a joined path never doubles up', () => {
        expect(resolveApiBase(buildCtx({ API_URL: 'https://api.example.com/' }).ctx)).toBe('https://api.example.com');
    });
});

// Card 0150: `WILSON_PROJECT` is how `johnny5` names a project — read the same way `resolveApiBase`
// reads `API_URL`/`PORT`, so every one of the 16 ported commands gets it for free through `apiClient`.
describe('resolveProject', () => {
    it('is undefined when WILSON_PROJECT is not set, so the SDK sends no project header at all', () => {
        expect(resolveProject(buildCtx().ctx)).toBeUndefined();
    });

    it('reads WILSON_PROJECT when set', () => {
        expect(resolveProject(buildCtx({ WILSON_PROJECT: 'acme' }).ctx)).toBe('acme');
    });

    it('trims surrounding whitespace, and treats an all-whitespace value the same as unset', () => {
        expect(resolveProject(buildCtx({ WILSON_PROJECT: '  acme  ' }).ctx)).toBe('acme');
        expect(resolveProject(buildCtx({ WILSON_PROJECT: '   ' }).ctx)).toBeUndefined();
    });
});

describe('apiClient', () => {
    it('builds a WilsonSdk pointed at the resolved base', () => {
        const { ctx } = buildCtx({ API_URL: 'https://api.example.com' });

        expect(apiClient(ctx)).toBeInstanceOf(WilsonSdk);
    });

    // Card 0150: `apiClient` wires `resolveProject(ctx)` into `WilsonSdk`'s `project` option, which
    // `createSdkFetch` (`packages/sdk/src/sdk-options.ts`) turns into an `X-Wilson-Project` header on
    // every call. Exercised through a real fetch, not a mock of `WilsonSdk` itself, so this proves the
    // header actually leaves on the wire rather than that some option object merely got constructed.
    describe('the project header it sends (Card 0150)', () => {
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        const stubbedFetch = () => {
            const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
            vi.stubGlobal('fetch', fetchMock);
            return fetchMock;
        };

        it('sends X-Wilson-Project on every call when WILSON_PROJECT is configured', async () => {
            const fetchMock = stubbedFetch();
            const { ctx } = buildCtx({ WILSON_PROJECT: 'acme' });

            await apiClient(ctx).board.listCards();

            const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
            expect(headers['X-Wilson-Project']).toBe('acme');
        });

        it('sends no X-Wilson-Project header at all when WILSON_PROJECT is not configured', async () => {
            const fetchMock = stubbedFetch();
            const { ctx } = buildCtx();

            await apiClient(ctx).board.listCards();

            const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
            expect(headers).not.toHaveProperty('X-Wilson-Project');
        });
    });
});

/**
 * Card 0150. `createSdkFetch`'s own new behavior, directly: `options.project`, when set, becomes an
 * `X-Wilson-Project` header on every request; when unset, the header is omitted outright rather than
 * sent empty, so a request from an SDK built before this card is byte-identical to one built after.
 */
describe('createSdkFetch project header (Card 0150)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const stubbedFetch = () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    };

    it('sends X-Wilson-Project set to the configured project on every request', async () => {
        const fetchMock = stubbedFetch();
        const sdkFetch = createSdkFetch({ baseUrl: 'http://api.example.com', project: 'acme' });

        await sdkFetch('/api/cards', { method: 'GET' });

        const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
        expect(headers['X-Wilson-Project']).toBe('acme');
    });

    it('sends no X-Wilson-Project header at all when no project is configured', async () => {
        const fetchMock = stubbedFetch();
        const sdkFetch = createSdkFetch({ baseUrl: 'http://api.example.com' });

        await sdkFetch('/api/cards', { method: 'GET' });

        const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
        expect(headers).not.toHaveProperty('X-Wilson-Project');
    });
});

describe('describeApiError', () => {
    it("reads an SdkError's operator-facing reason out of body.details.reason, not the generic HTTP status text", () => {
        const err = new SdkError(400, 'Bad Request', { details: { reason: '0072 is not flagged for a human' } }, new Headers());

        expect(describeApiError(err, buildCtx().ctx)).toBe('0072 is not flagged for a human');
    });

    it('falls back to body.message when an SdkError carries no details.reason', () => {
        const err = new SdkError(500, 'Internal Server Error', { message: 'something else broke' }, new Headers());

        expect(describeApiError(err, buildCtx().ctx)).toBe('something else broke');
    });

    it("falls back to the error's own message when an SdkError's body has neither reason nor message", () => {
        const err = new SdkError(500, 'Internal Server Error', {}, new Headers());

        expect(describeApiError(err, buildCtx().ctx)).toBe('500 Internal Server Error');
    });

    it('names the API location and how to start it for a connection refused error', () => {
        const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

        const message = describeApiError(err, buildCtx({ API_URL: 'http://localhost:9999' }).ctx);

        expect(message).toBe(
            'could not reach the API at http://localhost:9999 — is it running? start it with `pnpm --filter @wilson/api start` (or `pnpm dev` while iterating)',
        );
    });

    it('treats ENOTFOUND and ECONNRESET as connection failures too', () => {
        const notFound = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
        const reset = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });

        expect(describeApiError(notFound, buildCtx().ctx)).toContain('is it running?');
        expect(describeApiError(reset, buildCtx().ctx)).toContain('is it running?');
    });

    it('recognizes a bare "fetch failed" message as a connection failure even with no cause code', () => {
        const err = new Error('fetch failed');

        expect(describeApiError(err, buildCtx().ctx)).toContain('is it running?');
    });

    it('returns a plain Error message unchanged when it is neither an SdkError nor a connection failure', () => {
        const err = new Error('boom');

        expect(describeApiError(err, buildCtx().ctx)).toBe('boom');
    });

    it('stringifies a thrown non-Error value', () => {
        expect(describeApiError('boom', buildCtx().ctx)).toBe('boom');
    });
});

describe('withApi', () => {
    it("passes the handler's return value through untouched on success", async () => {
        const handler = vi.fn().mockResolvedValue(0);
        const wrapped = withApi(handler);
        const { ctx } = buildCtx();

        const result = await wrapped({}, ctx, []);

        expect(result).toBe(0);
        expect(handler).toHaveBeenCalledWith({}, ctx, [], expect.any(WilsonSdk));
    });

    it('logs the operator-facing reason and exits 1 when the handler throws an SdkError', async () => {
        const err = new SdkError(400, 'Bad Request', { details: { reason: '0072 is not flagged for a human' } }, new Headers());
        const wrapped = withApi(async () => {
            throw err;
        });
        const { ctx, logger } = buildCtx();

        const result = await wrapped({}, ctx, []);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('0072 is not flagged for a human');
    });

    it('logs the "is it running?" message and exits 1 when the handler throws a connection failure', async () => {
        const wrapped = withApi(async () => {
            throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        });
        const { ctx, logger } = buildCtx();

        const result = await wrapped({}, ctx, []);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
