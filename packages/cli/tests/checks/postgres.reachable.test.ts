import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `postgres.reachable.ts` talks to Postgres through the `pg` driver directly. Mocking `pg.Client`
 * lets these tests exercise the check's own logic — which values it wires into the connection and
 * how it reports "missing config" versus a real connection failure — without a real database.
 *
 * Card 0247: the five `DATABASE_*` values come from `apps/api/.env`, which johnny5 loads into
 * `ctx.env`, not `ctx.config` — before this card, this check always reported all five missing,
 * regardless of what `apps/api/.env` set. The `ctx` built below carries only `env` — no `config` at
 * all — so a check that still reached for `ctx.config.get` would throw here rather than merely
 * mis-report.
 */
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

const { postgresReachable } = await import('#src/checks/postgres.reachable.js');

describe('postgresReachable', () => {
    beforeEach(() => {
        endMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('no longer reports the DATABASE_* keys missing once they are set in ctx.env, and connects with them (AC1)', async () => {
        connectMock.mockResolvedValueOnce(undefined);
        queryMock.mockResolvedValueOnce({ rows: [{ version: 'PostgreSQL 16.1' }] });
        const ctx = {
            env: {
                DATABASE_HOST: 'db.internal',
                DATABASE_PORT: '6543',
                DATABASE_USER: 'wilson',
                DATABASE_PASSWORD: 'secret',
                DATABASE_NAME: 'wilson_db',
            },
        } as never;

        const result = await postgresReachable.run(ctx);

        expect(result.message).not.toContain('missing DB config');
        expect(result).toEqual({ ok: true, message: 'PostgreSQL 16.1' });
        expect(clientCtor).toHaveBeenCalledWith({
            host: 'db.internal',
            port: 6543,
            user: 'wilson',
            password: 'secret',
            database: 'wilson_db',
        });
    });

    it('still reports every key missing, by name, when nothing is configured (AC6)', async () => {
        const ctx = { env: {} } as never;

        const result = await postgresReachable.run(ctx);

        expect(result).toEqual({
            ok: false,
            message: 'missing DB config: DATABASE_HOST, DATABASE_PORT, DATABASE_USER, DATABASE_PASSWORD, DATABASE_NAME',
            fixHint: 'Set the DATABASE_* values in apps/api/.env.',
        });
        expect(clientCtor).not.toHaveBeenCalled();
    });
});
