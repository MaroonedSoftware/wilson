import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface GitResult {
    stdout: string;
    stderr: string;
}

/**
 * Run one git command.
 *
 * `execFile` with an argv array, never a shell string: card ids, branch names and commit messages
 * all reach this from a file on disk, and a shell would happily interpret whatever is in them.
 *
 * The runner's own credentials live in a credential helper git invokes for itself (PROJECT.md,
 * Deployment) — nothing here passes a token, and the agent's bash tool never reaches this function.
 */
export const git = async (cwd: string, args: string[]): Promise<GitResult> => {
    try {
        const { stdout, stderr } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
        return { stdout, stderr };
    } catch (err) {
        const e = err as { stderr?: string; message: string };
        throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${e.stderr?.trim() || e.message}`, { cause: err });
    }
};

/** True when the working tree has no uncommitted changes. */
export const isClean = async (cwd: string): Promise<boolean> => {
    const { stdout } = await git(cwd, ['status', '--porcelain']);
    return stdout.trim().length === 0;
};

/**
 * Compute `git merge-tree --write-tree`, the merge of `theirs` into `ours` done entirely in the
 * object database — no checkout, no index, nothing in `cwd`'s working tree moves (card 0143,
 * [[0025]]'s warning about merging in `codeRoot`).
 *
 * Unlike {@link git} above, a conflicting merge is not treated as a command failure: `merge-tree`
 * exits 1 and still writes a machine-readable report to stdout, which `git()`'s generic error
 * handling would discard (it keeps only `stderr`). This is the one caller that needs that stdout, so
 * it runs `exec` itself rather than going through `git()`, and still throws for every other kind of
 * failure — a bad ref, or `merge-tree` erroring before it could even attempt the merge.
 */
export const mergeTree = async (cwd: string, ours: string, theirs: string): Promise<{ ok: true; treeSha: string } | { ok: false; output: string }> => {
    try {
        const { stdout } = await exec('git', ['merge-tree', '--write-tree', ours, theirs], { cwd, maxBuffer: 32 * 1024 * 1024 });
        return { ok: true, treeSha: stdout.trim() };
    } catch (err) {
        const e = err as { code?: number; stdout?: string; message: string };
        if (e.code === 1 && typeof e.stdout === 'string') {
            return { ok: false, output: e.stdout };
        }
        throw new Error(`git merge-tree --write-tree ${ours} ${theirs} failed in ${cwd}: ${e.message}`, { cause: err });
    }
};

/**
 * The paths a conflicting {@link mergeTree} could not resolve.
 *
 * `merge-tree --write-tree`'s conflict report has two parts: a block of `ls-files --stage`-shaped
 * lines (`<mode> <object> <stage>\t<path>`, one per stage present for each conflicted path) meant to
 * be read by a machine, and free-text messages around it meant to be read by a person. This reads
 * only the first part — the messages vary by conflict type (content, add/add, rename/delete, ...) in
 * ways not worth pattern-matching when the structured lines already name every path directly.
 */
export const conflictingPaths = (mergeTreeOutput: string): string[] => {
    const paths = new Set<string>();
    for (const line of mergeTreeOutput.split('\n')) {
        const match = /^\d{6} [0-9a-f]{4,64} [1-3]\t(.+)$/.exec(line);
        if (match) paths.add(match[1]!);
    }
    return [...paths].sort();
};
