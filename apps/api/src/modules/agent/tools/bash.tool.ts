import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';
import { pnpmStoreLock } from '#modules/stages/run.command.js';
import type { ToolContext } from './tool.context.js';

const exec = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT = 512 * 1024;
// What is handed back to the model, as opposed to what the process may produce. A build log's
// signal is at its head and tail; the middle is resent on every later step for nothing.
const MAX_RETURNED = 12 * 1024;

/**
 * Run one of the commands this stage is allowed to run.
 *
 * There is no shell. `CommandAllowlist` parses the request into argv and `execFile` runs it
 * directly, so shell syntax has nobody to interpret it rather than being escaped.
 *
 * The environment is scrubbed: the runner's git credentials and the provider API keys are in this
 * process's env, and a build script is the obvious place to read them from (PROJECT.md, Agent
 * sandbox — "the bash tool never sees it").
 */
export const bashTool = (ctx: ToolContext) =>
    tool({
        description: 'Run an allowlisted shell command in the worktree. No shell syntax: no pipes, redirects, or chaining.',
        inputSchema: z.object({
            command: z.string().describe('The command, e.g. "pnpm build".'),
            timeout_ms: z.number().int().min(1000).max(600000).optional(),
        }),
        execute: async ({ command, timeout_ms }) => {
            const decision = ctx.commands.check(command);
            if (!decision.allowed) {
                await ctx.events.append({
                    project: ctx.project,
                    cardId: ctx.cardId,
                    stage: ctx.stage,
                    type: 'tool.denied',
                    payload: { tool: 'bash', command, reason: decision.reason },
                });
                return `error: ${decision.reason}`;
            }

            const [file, ...args] = decision.argv;
            const runOnce = () =>
                exec(file!, args, {
                    cwd: ctx.worktreeRoot,
                    timeout: timeout_ms ?? DEFAULT_TIMEOUT_MS,
                    maxBuffer: MAX_OUTPUT,
                    env: scrubbedEnv(),
                });

            // `pnpm install` writes to the same shared content-addressable store `setupCommand`
            // installs into (`run.command.ts`'s `pnpmStoreLock`). A stage is free to run its own
            // install — it is on `implementing`'s allowedCommands — and without this it races
            // another card's `setupCommand` for that store, which is what poisoned card 0081 itself.
            const isStoreWrite = file === 'pnpm' && args[0] === 'install';
            const result = await (
                isStoreWrite
                    ? pnpmStoreLock.run(`${ctx.cardId} ${ctx.stage} bash`, message => ctx.logger.info(message), runOnce)
                    : runOnce()
            ).catch((err: Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean }) => err);

            if (result instanceof Error) {
                const e = result as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
                if (e.killed) return `error: command timed out`;
                // A non-zero exit is information the agent needs, not a tool failure — return the
                // output so it can read the compiler error it just caused.
                return clamp([`exit code ${e.code ?? 'unknown'}`, e.stdout?.trim(), e.stderr?.trim()].filter(Boolean).join('\n\n'));
            }

            const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
            return output.length > 0 ? clamp(output) : 'exit code 0 (no output)';
        },
    });

/** Keep the head and tail of a long output; a build log's signal lives at both ends. */
const clamp = (output: string): string => {
    if (output.length <= MAX_RETURNED) return output;
    const half = Math.floor(MAX_RETURNED / 2);
    return `${output.slice(0, half)}\n\n… ${output.length - MAX_RETURNED} characters elided …\n\n${output.slice(-half)}`;
};

/**
 * The environment a stage command runs with.
 *
 * Allowlisted, not denylisted: a new secret added to the deployment's env should not silently become
 * visible to every build script because nobody remembered to add it to a deny list.
 */
const PASSED_THROUGH = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SHELL', 'USER', 'NODE_ENV'];

const scrubbedEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of PASSED_THROUGH) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
    }
    // Card-injected, so a dev server started by a stage does not collide with another card's.
    env.CI = 'true';
    return env;
};
