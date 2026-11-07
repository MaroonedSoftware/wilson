import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Duration } from 'luxon';

const GIT_TIMEOUT = Duration.fromObject({ minutes: 10 });

/**
 * Answers git's request for credentials from the environment. The token lives in this one process
 * tree: not in argv, where `ps` would show it, and not in the remote URL, which `clone` would keep
 * in `.git/config` for every later stage to read.
 */
const CREDENTIAL_HELPER = '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$WILSON_GIT_TOKEN"; }; f';

/** Runs git. A constructor parameter wherever it is used, so a test can stand in for it. */
export type GitRunner = (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string }>;

export const runGit: GitRunner = (args, env) => promisify(execFile)('git', args, { env: env ?? process.env, timeout: GIT_TIMEOUT.toMillis() });

/**
 * The arguments and environment that make one git command authenticate to GitHub as the app's
 * installation token, ignoring any helper the machine already has configured.
 */
export const asApp = (token: string, args: string[]): { args: string[]; env: NodeJS.ProcessEnv } => ({
    args: ['-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`, ...args],
    env: { ...process.env, WILSON_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0' },
});

/** The last line git wrote to stderr, which is where it says what went wrong, or the error's message. */
export const gitFailure = (err: unknown): string => (err as { stderr?: string }).stderr?.trim().split('\n').pop() || (err as Error).message;
