import pg from 'pg';
import type { Check } from '@maroonedsoftware/johnny5';

/**
 * Reachability of pg-boss's schema via the discrete DATABASE_* values, the same way
 * `postgresReachable` connects. This only reports whether the queue is usable — it never
 * enqueues anything, so it can't tell you a daemon is actually running.
 */
export const queueReachable: Check = {
    name: 'queue reachable',
    run: async ctx => {
        const client = new pg.Client({
            host: ctx.config.get('DATABASE_HOST', ''),
            port: Number(ctx.config.get('DATABASE_PORT', '5432')),
            user: ctx.config.get('DATABASE_USER', ''),
            password: ctx.config.get('DATABASE_PASSWORD', ''),
            database: ctx.config.get('DATABASE_NAME', ''),
        });

        try {
            await client.connect();
            const result = await client.query<{ exists: number }>(
                "select 1 as exists from information_schema.schemata where schema_name = 'pgboss'",
            );
            if (result.rows.length > 0) {
                return { ok: true, message: 'queue is installed' };
            }
            return { ok: true, message: 'queue has not been created yet; it is created the first time `wilson run` starts' };
        } catch (err) {
            return {
                ok: false,
                message: `connection failed: ${(err as Error).message}`,
                fixHint: 'Start Postgres (`docker compose up -d`) or check the DATABASE_* values in apps/api/.env.',
            };
        } finally {
            await client.end().catch(() => undefined);
        }
    },
};
