import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { Check } from '@maroonedsoftware/johnny5';
import { loadStages } from '@wilson/api/cli-bootstrap';

/**
 * The board must be queryable and its stage config must exist.
 *
 * Two halves because the board is split across two homes now. Cards, versions and transitions are
 * rows, so "is the board there" is a question about migrations having run — a failure mode that did
 * not exist when the board was files, and one whose natural error (`relation does not exist`, deep
 * inside a dispatch) says nothing useful about the fix.
 *
 * Stage config is still a file under `PROJECT_BOARD_ROOT`. It is machinery rather than board state:
 * human-write-only (decision 9), reviewed like code, and deliberately not reachable through any API
 * an agent could call.
 *
 * The old requirement that the board repo be *clean* is gone with the files. The runner no longer
 * commits card state, so there is nothing left for a stray uncommitted file to be swept into.
 */
export const boardReady: Check = {
    name: 'board ready',
    run: async ctx => {
        const root = ctx.config.get('PROJECT_BOARD_ROOT', '');
        if (!root) {
            return { ok: false, message: 'PROJECT_BOARD_ROOT is not set', fixHint: 'Set it in apps/api/.env, then run `wilson board init`.' };
        }
        if (!existsSync(join(root, 'config', 'stages.yaml'))) {
            return { ok: false, message: `no stage config at ${root}/config/stages.yaml`, fixHint: 'Run `wilson board init`.' };
        }
        try {
            await loadStages(root);
        } catch (err) {
            return {
                ok: false,
                message: `stage config at ${root}/config/stages.yaml is invalid: ${(err as Error).message}`,
                fixHint: 'Fix the stage config by hand — it is human-write-only.',
            };
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
            const project = ctx.config.get('PROJECT_NAME', 'wilson');
            const result = await client.query<{ count: string }>('select count(*)::text as count from runner.cards where project = $1', [project]);
            const count = Number(result.rows[0]?.count ?? '0');
            if (count === 0) {
                return {
                    ok: false,
                    message: `no cards for project "${project}"`,
                    fixHint: 'Import an existing board with `wilson board import`, or create one with `wilson card create`.',
                };
            }
            return { ok: true, message: `${count} cards · stage config at ${root}/config/stages.yaml` };
        } catch (err) {
            return {
                ok: false,
                message: `board tables unavailable: ${(err as Error).message}`,
                fixHint: 'Run `pnpm migrate:up`.',
            };
        } finally {
            await client.end().catch(() => undefined);
        }
    },
};
