import { git } from '#modules/board/git.js';

let head: string | undefined;

/**
 * Capture the commit this process is running, once, at boot.
 *
 * Read per request instead, `git rev-parse HEAD` reports whatever the code repo points at *now* —
 * which is exactly the commit a stale process is not running. A daemon left up across a merge would
 * report the new HEAD and look current, so the field meant to expose staleness would hide it. That
 * is not hypothetical: it was verified by running the server from a worktree at one commit and
 * watching `/api/health` report a different one.
 *
 * Node loads its modules once, so the value taken at boot is the value the process is serving.
 */
export const captureBuildHead = async (codeRoot: string): Promise<string> => {
    if (head === undefined) {
        const { stdout } = await git(codeRoot, ['rev-parse', '--short', 'HEAD']).catch(() => ({ stdout: 'unknown' }));
        head = stdout.trim() || 'unknown';
    }
    return head;
};

/** The commit captured at boot. `unknown` before `captureBuildHead` has run. */
export const buildHead = (): string => head ?? 'unknown';
