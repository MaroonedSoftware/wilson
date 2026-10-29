import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routers } from '#src/routes/routes.setup.js';
import { clearAccounts, holdAccounts } from '#tests/support/test.accounts.js';
import { onboardAndSignIn, request, startTestServer, type TestServer } from '#tests/support/test.server.js';

/**
 * Every route the server mounts is gated (PROJECT.md decision 10), or is on this list on purpose.
 *
 * The routes come from the mounted routers themselves, generated and hand-written alike, so a new
 * contract operation or a new hand-written route is covered the moment it exists: one that forgets
 * its `security` block answers something other than 401 here and fails the suite.
 */
const PUBLIC = new Set([
    // Liveness, for a monitor and for `wilson doctor` before sign-in.
    'GET /api/health',
    // First-run onboarding: there is nobody to authenticate yet.
    'GET /api/onboarding',
    'POST /api/onboarding',
    // Signing in, and signing out, which must work with a dead session.
    'POST /api/auth/token',
    'POST /api/auth/logout',
]);

/** Writes a `view` key may make, because each only takes authority away. */
const VIEW_KEY_WRITES = new Set(['DELETE /api/auth/keys/:id']);

interface Route {
    method: string;
    path: string;
}

/** Every (method, path) the mounted routers serve. `HEAD` rides along with `GET` and is skipped. */
const mountedRoutes = (): Route[] => {
    const seen = new Set<string>();
    const routes: Route[] = [];
    for (const router of routers()) {
        for (const layer of router.stack) {
            if (typeof layer.path !== 'string') continue;
            for (const method of layer.methods) {
                const key = `${method} ${layer.path}`;
                if (method === 'HEAD' || seen.has(key)) continue;
                seen.add(key);
                routes.push({ method, path: layer.path });
            }
        }
    }
    return routes;
};

/** A concrete URL for a route pattern: every `:param` becomes a placeholder value. */
const urlFor = (path: string): string => path.replace(/:[A-Za-z]+/g, 'x0000');

let server: TestServer;
let release: () => Promise<void>;
let viewKey: string;

beforeAll(async () => {
    release = await holdAccounts();
    server = await startTestServer();
    await clearAccounts(server.db);
    const { accessToken } = await onboardAndSignIn(server);
    const created = await request(server, 'POST', '/api/auth/keys', { token: accessToken, body: { name: 'read-only', scope: 'view' } });
    viewKey = ((await created.json()) as { token: string }).token;
});
afterAll(async () => {
    await clearAccounts(server.db);
    await server.stop();
    await release();
});

describe('authorization coverage', () => {
    const routes = mountedRoutes();

    it('finds the routes it is checking', () => {
        expect(routes.length).toBeGreaterThan(40);
        expect(routes).toContainEqual({ method: 'GET', path: '/api/feed' });
        expect(routes).toContainEqual({ method: 'GET', path: '/api/cards/:id/plan/stream' });
    });

    it('names only public routes that exist', () => {
        const mounted = new Set(routes.map(route => `${route.method} ${route.path}`));
        for (const route of PUBLIC) expect(mounted, route).toContain(route);
    });

    it('refuses every gated route without a credential, with 401', async () => {
        const unguarded: string[] = [];
        for (const route of routes) {
            const key = `${route.method} ${route.path}`;
            if (PUBLIC.has(key)) continue;
            const res = await request(server, route.method, urlFor(route.path));
            if (res.status !== 401) unguarded.push(`${key} answered ${res.status}`);
            await res.body?.cancel();
        }
        expect(unguarded).toEqual([]);
    });

    it('refuses every write to a view key, with 403 and insufficient_scope', async () => {
        const allowed: string[] = [];
        for (const route of routes) {
            const key = `${route.method} ${route.path}`;
            if (route.method === 'GET' || PUBLIC.has(key) || VIEW_KEY_WRITES.has(key)) continue;
            const res = await request(server, route.method, urlFor(route.path), { token: viewKey });
            if (res.status !== 403 || !res.headers.get('www-authenticate')?.includes('insufficient_scope')) {
                allowed.push(`${key} answered ${res.status}`);
            }
            await res.body?.cancel();
        }
        expect(allowed).toEqual([]);
    });

    it('lets a view key read', async () => {
        expect((await request(server, 'GET', '/api/auth/session', { token: viewKey })).status).toBe(200);
        expect((await request(server, 'GET', '/api/learnings', { token: viewKey })).status).not.toBe(403);
    });
});
