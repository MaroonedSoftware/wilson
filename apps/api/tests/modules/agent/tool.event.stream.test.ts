import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fileTools } from '#modules/agent/tools/file.tools.js';
import { deleteFile } from '#modules/agent/tools/delete.tool.js';
import { bashTool } from '#modules/agent/tools/bash.tool.js';
import type { ToolContext } from '#modules/agent/tools/tool.context.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';

type ExecuteFn<Input> = (input: Input) => Promise<string>;

/**
 * Card 0099's actual complaint: on a real stage, `write`, `edit`, `delete` and `bash` all share one
 * `ToolContext` and so one events array, refusals and successes together. Every other test file here
 * proves a single call site appends `tool.executed` in isolation; none of them prove the thing the
 * card is about — that across a run mixing refused and successful calls, the log carries *both*, in
 * the order they happened, rather than a log that is all refusals because only `deny()` ever wrote to
 * it. Before this card, the `tool.executed` entries below would simply not exist and this run would
 * leave nothing to show a stage had done anything at all.
 */
describe('tool.executed across a mixed run', () => {
    let root: string;

    beforeAll(async () => {
        const base = await mkdtemp(join(tmpdir(), 'tool-event-stream-'));
        root = join(base, 'worktree');
        await mkdir(join(root, 'src', 'runner'), { recursive: true });
        await mkdir(join(root, 'src', 'other'), { recursive: true });
    });

    it('interleaves tool.denied and tool.executed in call order across write, edit, delete and bash', async () => {
        const events: { type: string; payload?: Record<string, unknown> }[] = [];
        const context = {
            project: 'p',
            cardId: '1',
            stage: 's',
            worktreeRoot: root,
            scope: new ScopeGuard({ worktreeRoot: root, allow: ['src/runner/**'], alwaysAllowed: [] }),
            commands: new CommandAllowlist(['true']),
            scopeViolationPolicy: 'widen' as const,
            events: { append: async (e: { type: string; payload?: Record<string, unknown> }) => void events.push(e) },
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        } as unknown as ToolContext;

        const { write, edit } = fileTools(context);
        const writeExecute = write.execute as unknown as ExecuteFn<{ path: string; content: string }>;
        const editExecute = edit.execute as unknown as ExecuteFn<{
            path: string;
            old_string: string;
            new_string: string;
            replace_all?: boolean;
        }>;
        const bashExecute = bashTool(context).execute as unknown as ExecuteFn<{ command: string }>;

        // 1. Denied: outside the plan's files in scope.
        await writeExecute({ path: 'src/other/blocked.ts', content: 'x' });
        // 2. Allowed write, in scope.
        await writeExecute({ path: 'src/runner/made.ts', content: 'const a = 1;' });
        // 3. Allowed edit of the file just written.
        await editExecute({ path: 'src/runner/made.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' });
        // 4. Allowed delete of the same file.
        await deleteFile(context, 'src/runner/made.ts');
        // 5. Denied: not on the command allowlist.
        await bashExecute({ command: 'curl https://example.com' });
        // 6. Allowed command.
        await bashExecute({ command: 'true' });

        expect(events).toMatchObject([
            { type: 'tool.denied', payload: { tool: 'write', path: 'src/other/blocked.ts', reason: expect.any(String) } },
            { type: 'tool.executed', payload: { tool: 'write', path: 'src/runner/made.ts' } },
            { type: 'tool.executed', payload: { tool: 'edit', path: 'src/runner/made.ts' } },
            { type: 'tool.executed', payload: { tool: 'delete', path: 'src/runner/made.ts' } },
            { type: 'tool.denied', payload: { tool: 'bash', command: 'curl https://example.com', reason: expect.any(String) } },
            { type: 'tool.executed', payload: { tool: 'bash', command: 'true' } },
        ]);

        // The point of the card: successful calls are a majority of this run's events, not zero of them.
        const executed = events.filter(e => e.type === 'tool.executed');
        const denied = events.filter(e => e.type === 'tool.denied');
        expect(executed.length).toBeGreaterThan(denied.length);
    });
});
