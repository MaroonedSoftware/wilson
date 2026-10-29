import { describe, expect, it, vi } from 'vitest';
import { streamCookieMiddleware } from '#src/server/stream.cookie.middleware.js';

/** A context just wide enough for the middleware: method, path, headers, cookies. */
const contextFor = (method: string, path: string, options: { cookie?: string; authorization?: string } = {}) =>
    ({
        method,
        path,
        req: { headers: options.authorization ? { authorization: options.authorization } : {} },
        cookies: { get: (name: string) => (name === 'wilson_at' ? options.cookie : undefined) },
    }) as never as { req: { headers: Record<string, string> } };

const run = async (ctx: unknown) => {
    const next = vi.fn(async () => undefined);
    await streamCookieMiddleware()(ctx as never, next);
    expect(next).toHaveBeenCalledOnce();
};

describe('streamCookieMiddleware', () => {
    it('promotes the stream cookie to a bearer on the board feed', async () => {
        const ctx = contextFor('GET', '/api/feed', { cookie: 'token' });
        await run(ctx);
        expect(ctx.req.headers.authorization).toBe('Bearer token');
    });

    it('promotes it on a card plan stream', async () => {
        const ctx = contextFor('GET', '/api/cards/0042/plan/stream', { cookie: 'token' });
        await run(ctx);
        expect(ctx.req.headers.authorization).toBe('Bearer token');
    });

    it('leaves an explicit Authorization header alone', async () => {
        const ctx = contextFor('GET', '/api/feed', { cookie: 'token', authorization: 'Bearer header' });
        await run(ctx);
        expect(ctx.req.headers.authorization).toBe('Bearer header');
    });

    it('ignores the cookie on every other route', async () => {
        for (const [method, path] of [
            ['GET', '/api/cards'],
            ['POST', '/api/feed'],
            ['GET', '/api/cards/0042/plan'],
            ['POST', '/api/cards/0042/plan/stream'],
        ] as const) {
            const ctx = contextFor(method, path, { cookie: 'token' });
            await run(ctx);
            expect(ctx.req.headers.authorization).toBeUndefined();
        }
    });
});
