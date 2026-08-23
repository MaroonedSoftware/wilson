import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Check } from '@maroonedsoftware/johnny5';

const exec = promisify(execFile);

/**
 * The board repo must exist, be a git repo, and be clean.
 *
 * Clean matters because every transition is a commit of one card file. Starting a run with a dirty
 * board means the runner's commit sweeps up whatever else was sitting there uncommitted.
 */
export const boardRepoReady: Check = {
    name: 'board repo ready',
    run: async ctx => {
        const root = ctx.config.get('PROJECT_BOARD_ROOT', '');
        if (!root) {
            return { ok: false, message: 'PROJECT_BOARD_ROOT is not set', fixHint: 'Set it in apps/api/.env, then run `wilson board init`.' };
        }
        if (!existsSync(join(root, 'config', 'stages.yaml'))) {
            return { ok: false, message: `no board at ${root}`, fixHint: 'Run `wilson board init`.' };
        }

        try {
            const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: root });
            if (stdout.trim().length > 0) {
                return {
                    ok: false,
                    message: 'board repo has uncommitted changes',
                    fixHint: 'Commit or stash them; the runner commits card files itself and would sweep these up.',
                };
            }
            return { ok: true, message: root };
        } catch (err) {
            return { ok: false, message: `not a git repo: ${(err as Error).message}`, fixHint: 'Run `wilson board init`.' };
        }
    },
};
