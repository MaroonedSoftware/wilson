import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Check } from '@maroonedsoftware/johnny5';

const exec = promisify(execFile);

/**
 * The code repo must be a git repo with at least one commit.
 *
 * Worktrees are cut from HEAD, so an unborn branch fails deep inside dispatch with git's own
 * "ambiguous argument 'HEAD'" — which reads like a bug in the runner rather than a repo that has
 * simply never been committed to. Catch it here, where the fix is obvious.
 */
export const codeRepoReady: Check = {
    name: 'code repo ready',
    run: async ctx => {
        const root = ctx.config.get('PROJECT_CODE_ROOT', '');
        if (!root) {
            return { ok: false, message: 'PROJECT_CODE_ROOT is not set', fixHint: 'Set it in apps/api/.env.' };
        }

        try {
            const { stdout } = await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
            return { ok: true, message: `${root} @ ${stdout.trim()}` };
        } catch {
            return {
                ok: false,
                message: 'no commits on the current branch',
                fixHint: 'Worktrees are cut from HEAD. Make an initial commit in the code repo first.',
            };
        }
    },
};
