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
