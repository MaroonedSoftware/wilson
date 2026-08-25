import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolContext } from './tool.context.js';

/**
 * Delete one file in the worktree.
 *
 * Scope-checked exactly like `write` and `edit`: a stage that cannot write a path must not be able
 * to delete it either, and a denial reads the same way a write's does. `ScopeGuard.check` already
 * refuses anything that resolves outside the worktree, so containment needs no separate handling
 * here.
 *
 * Deliberately narrower than `rm`: one path, no glob, no recursion. A directory is refused rather
 * than emptied, because a plan that meant to remove a whole directory would say so and this tool
 * gives it no way to.
 *
 * Shared by both adapters — the `api` adapter's `delete` tool below, and the `cli` adapter's
 * in-process MCP tool of the same name — so the two cannot drift in what a deletion means, the same
 * split `request_scope`/`requestScope` already makes.
 */
export const deleteFile = async (ctx: ToolContext, path: string): Promise<string> => {
    const decision = await ctx.scope.check(path);
    if (!decision.allowed) {
        await ctx.events.append({
            project: ctx.project,
            cardId: ctx.cardId,
            stage: ctx.stage,
            type: 'tool.denied',
            payload: { tool: 'delete', path, reason: decision.reason },
        });
        return `error: ${decision.reason} (${path}). Use request_scope if this file genuinely belongs in this card.`;
    }

    const absolute = join(ctx.worktreeRoot, decision.path);
    const info = await stat(absolute).catch((err: Error) => err);
    if (info instanceof Error) return `error: could not delete ${decision.path}: ${info.message}`;
    if (info.isDirectory()) return `error: ${decision.path} is a directory; delete takes a single file, not a directory`;

    await unlink(absolute);
    return `deleted ${decision.path}`;
};

export const deleteTool = (ctx: ToolContext) =>
    tool({
        description: 'Delete one file in the worktree. Refuses a directory; use it once per file, never recursively.',
        inputSchema: z.object({
            path: z.string().describe('Path relative to the worktree root.'),
        }),
        execute: async ({ path }) => deleteFile(ctx, path),
    });
