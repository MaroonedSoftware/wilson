import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolContext } from './tool.context.js';

const MAX_READ_BYTES = 512 * 1024;

/**
 * Read, write and edit, all confined to the worktree.
 *
 * Reads are containment-checked; writes go through the full scope check. A denied write is recorded
 * to the event log and returned to the model as an error string rather than thrown, so the agent can
 * adapt (or call `request_scope`) instead of the whole stage dying on a single bad path.
 */
export const fileTools = (ctx: ToolContext) => ({
    read: tool({
        description: 'Read a UTF-8 text file from the worktree. Paths are relative to the worktree root.',
        inputSchema: z.object({
            path: z.string().describe('Path relative to the worktree root.'),
            offset: z.number().int().min(1).optional().describe('1-indexed line to start from.'),
            limit: z.number().int().min(1).optional().describe('Maximum number of lines to return.'),
        }),
        execute: async ({ path, offset, limit }) => {
            const decision = await ctx.scope.checkRead(path);
            if (!decision.allowed) return `error: ${decision.reason} (${path})`;

            const absolute = join(ctx.worktreeRoot, decision.path);
            const raw = await readFile(absolute, 'utf8').catch((err: Error) => err);
            if (raw instanceof Error) return `error: could not read ${decision.path}: ${raw.message}`;
            if (raw.length > MAX_READ_BYTES && !offset && !limit) {
                return `error: ${decision.path} is ${raw.length} bytes; re-read it with offset and limit.`;
            }

            const lines = raw.split('\n');
            const start = (offset ?? 1) - 1;
            const slice = lines.slice(start, limit ? start + limit : undefined);
            return slice.map((line, i) => `${start + i + 1}\t${line}`).join('\n');
        },
    }),

    write: tool({
        description: 'Write a file in the worktree, creating it if needed. Overwrites the whole file.',
        inputSchema: z.object({
            path: z.string().describe('Path relative to the worktree root.'),
            content: z.string(),
        }),
        execute: async ({ path, content }) => {
            const decision = await ctx.scope.check(path);
            if (!decision.allowed) {
                await ctx.events.append({
                    project: ctx.project,
                    cardId: ctx.cardId,
                    stage: ctx.stage,
                    type: 'tool.denied',
                    payload: { tool: 'write', path, reason: decision.reason },
                });
                return `error: ${decision.reason} (${path}). Use request_scope if this file genuinely belongs in this card.`;
            }

            const absolute = join(ctx.worktreeRoot, decision.path);
            await mkdir(dirname(absolute), { recursive: true });
            await writeFile(absolute, content, 'utf8');
            return `wrote ${decision.path} (${content.length} bytes)`;
        },
    }),

    edit: tool({
        description: 'Replace an exact string in a file. Fails if the string is absent or ambiguous.',
        inputSchema: z.object({
            path: z.string().describe('Path relative to the worktree root.'),
            old_string: z.string().describe('Exact text to replace, including indentation.'),
            new_string: z.string(),
            replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring a unique match.'),
        }),
        execute: async ({ path, old_string, new_string, replace_all }) => {
            const decision = await ctx.scope.check(path);
            if (!decision.allowed) {
                await ctx.events.append({
                    project: ctx.project,
                    cardId: ctx.cardId,
                    stage: ctx.stage,
                    type: 'tool.denied',
                    payload: { tool: 'edit', path, reason: decision.reason },
                });
                return `error: ${decision.reason} (${path}). Use request_scope if this file genuinely belongs in this card.`;
            }

            const absolute = join(ctx.worktreeRoot, decision.path);
            const current = await readFile(absolute, 'utf8').catch((err: Error) => err);
            if (current instanceof Error) return `error: could not read ${decision.path}: ${current.message}`;

            const occurrences = current.split(old_string).length - 1;
            if (occurrences === 0) return `error: old_string not found in ${decision.path}`;
            // An ambiguous edit is refused rather than guessed: replacing the first of several
            // matches is how an agent silently changes the wrong line.
            if (occurrences > 1 && !replace_all) {
                return `error: old_string appears ${occurrences} times in ${decision.path}; pass replace_all or include more context`;
            }

            const updated = replace_all ? current.split(old_string).join(new_string) : current.replace(old_string, new_string);
            await writeFile(absolute, updated, 'utf8');
            return `edited ${decision.path} (${occurrences} replacement${occurrences === 1 ? '' : 's'})`;
        },
    }),
});
