import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { deleteFile, deleteTool } from '#modules/agent/tools/delete.tool.js';
import type { ToolContext } from '#modules/agent/tools/tool.context.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';

/**
 * Card 0086: before this, nothing in the agent's tool set could remove a file at all — the write
 * tools only create and edit, and the sandboxed bash allowlist has no `rm`. `deleteFile` is the new
 * seam, shared by both adapters, so it is exercised directly here against a real worktree rather than
 * through a mock, the same way `scope.guard.test.ts` drives `ScopeGuard` itself.
 */
describe('deleteFile', () => {
    let root: string;
    let outside: string;

    beforeAll(async () => {
        const base = await mkdtemp(join(tmpdir(), 'delete-tool-'));
        root = join(base, 'worktree');
        outside = join(base, 'outside');
        await mkdir(join(root, 'src', 'runner'), { recursive: true });
        await mkdir(join(root, 'src', 'other'), { recursive: true });
        await mkdir(outside, { recursive: true });
    });

    const buildContext = (allow: string[] = ['src/runner/**']) => {
        const events: { type: string; payload?: Record<string, unknown> }[] = [];
        const context = {
            project: 'p',
            cardId: '1',
            stage: 's',
            worktreeRoot: root,
            scope: new ScopeGuard({ worktreeRoot: root, allow, alwaysAllowed: [] }),
            commands: new CommandAllowlist(['pnpm build']),
            scopeViolationPolicy: 'widen' as const,
            events: { append: async (e: { type: string; payload?: Record<string, unknown> }) => void events.push(e) },
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        } as unknown as ToolContext;
        return { context, events };
    };

    it('deletes a file inside the plan’s files in scope, and it is actually gone from disk', async () => {
        const { context, events } = buildContext();
        await writeFile(join(root, 'src', 'runner', 'gone.ts'), 'x', 'utf8');

        const message = await deleteFile(context, 'src/runner/gone.ts');

        expect(message).toContain('deleted');
        expect(message).toContain('src/runner/gone.ts');
        await expect(stat(join(root, 'src', 'runner', 'gone.ts'))).rejects.toThrow();
        // Card 0099: a successful delete is recorded too, not just a refused one — the counterpart
        // to the denial event below, naming the same tool and path.
        expect(events).toMatchObject([{ type: 'tool.executed', payload: { tool: 'delete', path: 'src/runner/gone.ts' } }]);
    });

    it('refuses a path outside the plan’s files in scope, with the same reason a write gets, and does not delete it', async () => {
        const { context, events } = buildContext();
        await writeFile(join(root, 'src', 'other', 'keep.ts'), 'x', 'utf8');

        const message = await deleteFile(context, 'src/other/keep.ts');

        expect(message).toContain('error');
        expect(message).toContain('outside the plan');
        // Same event type and shape write/edit log on a denial.
        expect(events).toMatchObject([
            {
                type: 'tool.denied',
                payload: {
                    tool: 'delete',
                    path: 'src/other/keep.ts',
                    reason: 'path is outside the plan’s files in scope — call request_scope with this path if the work genuinely needs it',
                },
            },
        ]);
        await expect(stat(join(root, 'src', 'other', 'keep.ts'))).resolves.toBeDefined();
    });

    it('refuses a path that resolves outside the worktree entirely, distinct from an out-of-scope refusal', async () => {
        const { context } = buildContext(['**']);
        await writeFile(join(outside, 'secret.txt'), 'x', 'utf8');

        const message = await deleteFile(context, join(outside, 'secret.txt'));

        expect(message).toContain('error');
        expect(message).toContain('outside the worktree');
        await expect(stat(join(outside, 'secret.txt'))).resolves.toBeDefined();
    });

    it('refuses a directory rather than deleting it, even when the directory itself is in scope', async () => {
        const { context } = buildContext(['**']);
        await mkdir(join(root, 'src', 'runner', 'adir'), { recursive: true });

        const message = await deleteFile(context, 'src/runner/adir');

        expect(message).toContain('error');
        expect(message).toContain('directory');
        await expect(stat(join(root, 'src', 'runner', 'adir'))).resolves.toBeDefined();
    });

    it('deleteTool wraps the same deleteFile function rather than a separate copy of the logic', async () => {
        const { context } = buildContext();
        await writeFile(join(root, 'src', 'runner', 'wrapped.ts'), 'x', 'utf8');
        const { execute } = deleteTool(context) as unknown as { execute: (input: { path: string }) => Promise<string> };

        const result = await execute({ path: 'src/runner/wrapped.ts' });

        expect(result).toContain('deleted');
        await expect(stat(join(root, 'src', 'runner', 'wrapped.ts'))).rejects.toThrow();
    });
});
