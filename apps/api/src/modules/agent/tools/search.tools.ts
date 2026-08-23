import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolContext } from './tool.context.js';

const exec = promisify(execFile);
const MAX_RESULTS = 200;

/**
 * Discovery, so the agent can find code without reading whole files into context.
 *
 * Both shell out with argv arrays and no shell. They use git's own matcher over tracked and
 * untracked files, so .gitignore is respected by default — an agent grepping all of node_modules is
 * an agent that has spent its budget before it starts.
 *
 * `include_ignored` is the deliberate exception. Reading a dependency's type definitions is a normal
 * part of the work, and without it the only way to find them is a filesystem walk the sandbox
 * refuses: card 0001 burned six tool calls on `find /` before giving up and guessing. The pathspec
 * bounds the cost, so an opt-in search under `node_modules/<pkg>/` stays cheap.
 */
export const searchTools = (ctx: ToolContext) => ({
    glob: tool({
        description: 'List files in the worktree matching a glob pattern, respecting .gitignore.',
        inputSchema: z.object({
            pattern: z.string().describe('A glob, e.g. "src/**/*.ts".'),
            include_ignored: z
                .boolean()
                .optional()
                .describe('Also search gitignored paths. Use this to find dependency sources under node_modules/.'),
        }),
        execute: async ({ pattern, include_ignored }) => {
            const args = ['ls-files', '--cached', '--others'];
            if (!include_ignored) args.push('--exclude-standard');
            const result = await exec('git', [...args, '--', pattern], {
                cwd: ctx.worktreeRoot,
                maxBuffer: 8 * 1024 * 1024,
            }).catch((err: Error) => err);
            if (result instanceof Error) return `error: glob failed: ${result.message}`;

            const files = result.stdout.split('\n').filter(Boolean);
            if (files.length === 0) return 'no matches';
            return files.slice(0, MAX_RESULTS).join('\n') + (files.length > MAX_RESULTS ? `\n… ${files.length - MAX_RESULTS} more` : '');
        },
    }),

    grep: tool({
        description: 'Search file contents in the worktree with a regular expression.',
        inputSchema: z.object({
            pattern: z.string().describe('A regular expression.'),
            path: z.string().optional().describe('Limit the search to this directory or file.'),
            glob: z.string().optional().describe('Limit the search to files matching this glob.'),
            include_ignored: z
                .boolean()
                .optional()
                .describe('Also search gitignored paths. Pair with path or glob, or this searches every dependency.'),
        }),
        execute: async ({ pattern, path, glob, include_ignored }) => {
            // `git grep` rather than a bare regex walk: it honours .gitignore and searches untracked
            // files too, so a file the agent just created is findable.
            const args = ['grep', '-n', '--untracked', '--no-color'];
            if (include_ignored) args.push('--no-exclude-standard');
            args.push('-e', pattern);
            if (glob) args.push('--', glob);
            else if (path) {
                const decision = await ctx.scope.checkRead(path);
                if (!decision.allowed) return `error: ${decision.reason} (${path})`;
                args.push('--', decision.path);
            }

            const result = await exec('git', args, { cwd: ctx.worktreeRoot, maxBuffer: 8 * 1024 * 1024 }).catch(
                (err: Error & { code?: number }) => err,
            );
            // git grep exits 1 with no output when nothing matched, which is not an error.
            if (result instanceof Error) {
                const code = (result as Error & { code?: number }).code;
                if (code === 1) return 'no matches';
                return `error: grep failed: ${result.message}`;
            }

            const lines = result.stdout.split('\n').filter(Boolean);
            if (lines.length === 0) return 'no matches';
            return lines.slice(0, MAX_RESULTS).join('\n') + (lines.length > MAX_RESULTS ? `\n… ${lines.length - MAX_RESULTS} more` : '');
        },
    }),
});
