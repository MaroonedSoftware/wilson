import pg from 'pg';
import type { Check } from '@maroonedsoftware/johnny5';

/**
 * Reachability via the discrete DATABASE_* values, exactly the way the data module connects — so a
 * green check means the app will connect, not merely that something is listening.
 */
export const postgresReachable: Check = {
    name: 'postgres reachable',
    run: async ctx => {
        const required = ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME'];
        const missing = required.filter(key => !ctx.config.get(key, ''));
        if (missing.length > 0) {
            return { ok: false, message: `missing DB config: ${missing.join(', ')}`, fixHint: 'Set the DATABASE_* values in apps/api/.env.' };
        }

        const client = new pg.Client({
            host: ctx.config.get('DATABASE_HOST', ''),
            port: Number(ctx.config.get('DATABASE_PORT', '5432')),
            user: ctx.config.get('DATABASE_USER', ''),
            password: ctx.config.get('DATABASE_PASSWORD', ''),
            database: ctx.config.get('DATABASE_NAME', ''),
        });

        try {
            await client.connect();
            const result = await client.query<{ version: string }>('select version() as version');
            return { ok: true, message: (result.rows[0]?.version ?? 'unknown').split(' ').slice(0, 2).join(' ') };
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
