import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Container } from 'injectkit';
import { Kysely } from 'kysely';
import { ServerKitServerBuilder, type ServerKitRouterType } from '@maroonedsoftware/koa';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import type { DB } from '#modules/data/db.js';
import { modules } from '#modules/modules.js';
import { routers } from '#src/routes/routes.setup.js';
import { setupMiddleware } from '#src/server/setup.middleware.js';
import { buildTestServerConfig } from './test.config.js';

/**
 * Reaches `listen` directly, because `start` would also run every module's `start` hook, the job
 * runner's among them, which has no business running in a test.
 */
class ListeningBuilder extends ServerKitServerBuilder {
    serve(signal: AbortSignal): Promise<Server> {
        return this.listen(0, signal);
    }
}

export interface TestServer {
    /** `http://127.0.0.1:<port>`. */
    base: string;
    container: Container;
    db: Kysely<DB>;
    /** Closes the server and the pool. */
    stop: () => Promise<void>;
}

/**
 * The app's own container, middleware and routers, on an ephemeral port, against the test
 * database: the HTTP surface as a client sees it, with no job runner behind it.
 */
export const startTestServer = async (): Promise<TestServer> => {
    const abort = new AbortController();
    const builder = new ListeningBuilder();
    const config = await buildTestServerConfig();
    const container = await builder.setup(config, new ConsoleLogger(), modules);
    builder.setupMiddleware(setupMiddleware(config)).setupRoutes(routers(abort.signal) as ServerKitRouterType[]);
    const server = await builder.serve(abort.signal);
    const db = container.get(Kysely<DB>);
    return {
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        container,
        db,
        stop: async () => {
            abort.abort();
            await db.destroy();
        },
    };
};

/** One JSON request against `server`, with an optional bearer token. */
export const request = (
    server: TestServer,
    method: string,
    path: string,
    options: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
) =>
    fetch(`${server.base}${path}`, {
        method,
        headers: {
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
            ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

/** A password strong enough for the zxcvbn policy. */
export const STRONG_PASSWORD = 'correct horse battery staple 47';

/** Onboard the operator account and sign in, returning the session's tokens. */
export const onboardAndSignIn = async (server: TestServer): Promise<{ accessToken: string; refreshToken: string }> => {
    const onboarded = await request(server, 'POST', '/api/onboarding', { body: { email: 'operator@example.com', password: STRONG_PASSWORD } });
    if (onboarded.status !== 201) throw new Error(`onboarding answered ${onboarded.status}`);
    const res = await request(server, 'POST', '/api/auth/token', {
        body: { grant_type: 'password', email: 'operator@example.com', password: STRONG_PASSWORD },
    });
    if (res.status !== 200) throw new Error(`sign-in answered ${res.status}`);
    return (await res.json()) as { accessToken: string; refreshToken: string };
};
