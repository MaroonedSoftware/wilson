import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface CommandFailure {
    reason: string;
}

/**
 * Run a configured command in a worktree, without a shell.
 *
 * Shared by worktree setup and exit-condition verification. Both take their command from stage
 * config rather than from the agent, so the allowlist does not apply — but the no-shell rule still
 * does, because a config string is not a reason to hand anything a shell.
 */
export const runConfiguredCommand = async (cwd: string, command: string, timeoutMs = 10 * 60 * 1000): Promise<CommandFailure | undefined> => {
    const [file, ...args] = command.trim().split(/\s+/).filter(Boolean);
    if (!file) return { reason: 'configured command is empty' };

    try {
        await exec(file, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
        return undefined;
    } catch (err) {
        const e = err as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
        if (e.killed) return { reason: `\`${command}\` timed out` };
        const output = [e.stdout?.trim(), e.stderr?.trim()].filter(Boolean).join('\n').slice(-4000);
        return { reason: `\`${command}\` failed (exit ${e.code ?? 'unknown'})\n${output}` };
    }
};
