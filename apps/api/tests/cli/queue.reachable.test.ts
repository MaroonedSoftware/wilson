import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '@maroonedsoftware/appconfig';

// `queue.reachable.ts` talks to Postgres through the `pg` driver directly (the same way
// `postgres.reachable.ts` does). Mocking `pg.Client` lets these tests exercise the check's own
// logic — which config values it wires into the connection, how it interprets the `pgboss` schema
// query, and how it reports failures — without a real database.
const connectMock = vi.fn();
const queryMock = vi.fn();
const endMock = vi.fn();
const clientCtor = vi.fn();

vi.mock('pg', () => ({
    default: {
        Client: class {
            constructor(options: unknown) {
                clientCtor(options);
            }
            connect = connectMock;
            query = queryMock;
            end = endMock;
        },
    },
}));

// Imported after the mock above is declared; vi.mock calls are hoisted above imports by vitest, so
// by the time this module (and transitively queue.reachable.ts) loads, `pg.Client` is already the
// stub defined above.
const { queueReachable } = await import('../../../../packages/cli/src/checks/queue.reachable.js');

type CheckResult = { ok: boolean; message: string; fixHint?: string };
type RunFn = (ctx: unknown) => Promise<CheckResult>;

const run = queueReachable.run as unknown as RunFn;

const buildCtx = (values: Record<string, string>) => ({ config: new AppConfig(values) });

describe('queueReachable', () => {
    beforeEach(() => {
        endMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('reports the queue as installed when the pgboss schema exists', async () => {
        connectMock.mockResolvedValueOnce(undefined);
        queryMock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });

        const result = await run(buildCtx({}));

        expect(result).toEqual({ ok: true, message: 'queue is installed' });
        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(endMock).toHaveBeenCalledTimes(1);
    });

    it('reports the queue as not yet created when the pgboss schema is missing', async () => {
        connectMock.mockResolvedValueOnce(undefined);
        queryMock.mockResolvedValueOnce({ rows: [] });

        const result = await run(buildCtx({}));

        expect(result.ok).toBe(true);
        // Card 0079: the queue is created by the API booting now, not by `wilson run`, which no
        // longer exists.
        expect(result.message).toBe('queue has not been created yet; it is created the first time the API starts');
        expect(result.message).not.toContain('wilson run');
    });

    it('checks specifically for the pgboss schema', async () => {
        connectMock.mockResolvedValueOnce(undefined);
        queryMock.mockResolvedValueOnce({ rows: [] });

        await run(buildCtx({}));

        expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('pgboss'));
    });

    it('reports failure with a fix hint when the connection fails', async () => {
        connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        const result = await run(buildCtx({}));

        expect(result.ok).toBe(false);
        expect(result.message).toBe('connection failed: ECONNREFUSED');
        expect(result.fixHint).toContain('docker compose up -d');
        // Even on a failed connect, the client is still cleaned up.
        expect(endMock).toHaveBeenCalledTimes(1);
    });

    it('builds the client from the discrete DATABASE_* config values', async () => {
        connectMock.mockResolvedValueOnce(undefined);
        queryMock.mockResolvedValueOnce({ rows: [] });

        await run(
            buildCtx({
                DATABASE_HOST: 'db.example.internal',
                DATABASE_PORT: '6543',
                DATABASE_USER: 'wilson',
                DATABASE_PASSWORD: 'secret',
                DATABASE_NAME: 'wilsondb',
            }),
        );

        expect(clientCtor).toHaveBeenCalledWith({
            host: 'db.example.internal',
            port: 6543,
            user: 'wilson',
            password: 'secret',
            database: 'wilsondb',
        });
    });

    it('defaults to port 5432 when DATABASE_PORT is not configured', async () => {
        connectMock.mockResolvedValueOnce(undefined);
        queryMock.mockResolvedValueOnce({ rows: [] });

        await run(buildCtx({}));

        expect(clientCtor).toHaveBeenCalledWith(expect.objectContaining({ port: 5432 }));
    });
});
