import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fileTools } from '#modules/agent/tools/file.tools.js';
import type { ToolContext } from '#modules/agent/tools/tool.context.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';

type ExecuteFn<Input> = (input: Input) => Promise<string>;

/**
 * Card 0099: `write` and `edit` now append a `tool.executed` event on success, alongside the
 * `tool.denied` they already appended on refusal. Before this, a successful write or edit left no
 * trace in the event log at all — `wilson card show` could only ever say what a stage was stopped
 * from doing, never what it did. Driven directly against a real worktree, the same way
 * `delete.tool.test.ts` exercises `deleteFile`.
 */
describe('fileTools', () => {
    let root: string;

    beforeAll(async () => {
        const base = await mkdtemp(join(tmpdir(), 'file-tools-'));
        root = join(base, 'worktree');
        await mkdir(join(root, 'src', 'runner'), { recursive: true });
        await mkdir(join(root, 'src', 'other'), { recursive: true });
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

    describe('write', () => {
        it('appends tool.executed naming the tool and path once the write actually lands on disk', async () => {
            const { context, events } = buildContext();
            const { write } = fileTools(context);
            const execute = write.execute as unknown as ExecuteFn<{ path: string; content: string }>;

            const message = await execute({ path: 'src/runner/new.ts', content: 'hello' });

            expect(message).toContain('wrote');
            await expect(readFile(join(root, 'src', 'runner', 'new.ts'), 'utf8')).resolves.toBe('hello');
            expect(events).toMatchObject([{ type: 'tool.executed', payload: { tool: 'write', path: 'src/runner/new.ts' } }]);
        });

        it('still refuses a write outside scope, still recording only the denial — no executed event', async () => {
            const { context, events } = buildContext();
            const { write } = fileTools(context);
            const execute = write.execute as unknown as ExecuteFn<{ path: string; content: string }>;

            const message = await execute({ path: 'src/other/new.ts', content: 'hello' });

            expect(message).toContain('error');
            expect(events).toMatchObject([{ type: 'tool.denied', payload: { tool: 'write', path: 'src/other/new.ts' } }]);
            expect(events).toHaveLength(1);
        });
    });

    describe('edit', () => {
        it('appends tool.executed naming the tool and path once the edit actually lands on disk', async () => {
            const { context, events } = buildContext();
            await writeFile(join(root, 'src', 'runner', 'edit-me.ts'), 'const a = 1;', 'utf8');
            const { edit } = fileTools(context);
            const execute = edit.execute as unknown as ExecuteFn<{
                path: string;
                old_string: string;
                new_string: string;
                replace_all?: boolean;
            }>;

            const message = await execute({ path: 'src/runner/edit-me.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' });

            expect(message).toContain('edited');
            await expect(readFile(join(root, 'src', 'runner', 'edit-me.ts'), 'utf8')).resolves.toBe('const a = 2;');
            expect(events).toMatchObject([{ type: 'tool.executed', payload: { tool: 'edit', path: 'src/runner/edit-me.ts' } }]);
        });

        it('still refuses an edit outside scope, still recording only the denial — no executed event', async () => {
            const { context, events } = buildContext();
            await writeFile(join(root, 'src', 'other', 'edit-me.ts'), 'const a = 1;', 'utf8');
            const { edit } = fileTools(context);
            const execute = edit.execute as unknown as ExecuteFn<{
                path: string;
                old_string: string;
                new_string: string;
                replace_all?: boolean;
            }>;

            const message = await execute({ path: 'src/other/edit-me.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' });

            expect(message).toContain('error');
            expect(events).toMatchObject([{ type: 'tool.denied', payload: { tool: 'edit', path: 'src/other/edit-me.ts' } }]);
            expect(events).toHaveLength(1);
        });
    });

    describe('read', () => {
        it('appends nothing at all, successful or not — reads must not swamp the event log', async () => {
            const { context, events } = buildContext();
            await writeFile(join(root, 'src', 'runner', 'readable.ts'), 'content', 'utf8');
            const { read } = fileTools(context);
            const execute = read.execute as unknown as ExecuteFn<{ path: string; offset?: number; limit?: number }>;

            await execute({ path: 'src/runner/readable.ts' });
            await execute({ path: 'src/does-not-exist.ts' });

            expect(events).toHaveLength(0);
        });
    });
});
