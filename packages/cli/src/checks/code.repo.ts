import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { Check } from '@maroonedsoftware/johnny5';

const exec = promisify(execFile);

/**
 * The code repo must be a git repo with at least one commit.
 *
 * Worktrees are cut from HEAD, so an unborn branch fails deep inside dispatch with git's own
 * "ambiguous argument 'HEAD'" — which reads like a bug in the runner rather than a repo that has
 * simply never been committed to. Catch it here, where the fix is obvious.
 *
 * Also notices a configured `core.hooksPath`. Card 0071 makes `WorktreeManager.commit` pass
 * `--no-verify`, so whatever hooks a project installs there never run on a stage's commit — silently
 * bypassing something an operator configured on purpose is worth a notice, even though nothing about
 * their repo is misconfigured. It is a notice, not a failure: `describeHooks` never changes `ok`.
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
            const hooksNotice = await describeHooks(root);
            return { ok: true, message: `${root} @ ${stdout.trim()}${hooksNotice}` };
        } catch {
            return {
                ok: false,
                message: 'no commits on the current branch',
                fixHint: 'Worktrees are cut from HEAD. Make an initial commit in the code repo first.',
            };
        }
    },
};

/**
 * Describe a project's configured `core.hooksPath`, if it names a directory that actually holds
 * hooks. Returns '' — nothing to append — when `core.hooksPath` isn't set, or resolves to a
 * directory that doesn't exist or is empty, so a project with no hooks reports nothing new.
 *
 * Only the explicitly configured path is checked, not git's implicit default of `<gitdir>/hooks`:
 * `core.hooksPath` is what an operator deliberately pointed at something (husky, lefthook, and
 * similar tools all set it), which is the case worth surfacing — a repo that has simply never had
 * hooks installed is not.
 */
async function describeHooks(root: string): Promise<string> {
    const hooksPath = await exec('git', ['config', '--get', 'core.hooksPath'], { cwd: root }).then(
        ({ stdout }) => stdout.trim(),
        () => '',
    );
    if (!hooksPath) return '';

    // Relative to the working tree's top level — git's own resolution rule for a relative
    // core.hooksPath.
    const resolved = isAbsolute(hooksPath) ? hooksPath : join(root, hooksPath);
    const entries = await readdir(resolved).catch(() => []);
    if (entries.length === 0) return '';

    return ` · core.hooksPath=${hooksPath} (${entries.length} hook${entries.length === 1 ? '' : 's'}) — stage commits use --no-verify and bypass ${entries.length === 1 ? 'it' : 'them'}`;
}
