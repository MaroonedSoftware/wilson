import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bashTool } from '#modules/agent/tools/bash.tool.js';
import type { ToolContext } from '#modules/agent/tools/tool.context.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';

type ExecuteFn = (input: { command: string; timeout_ms?: number }) => Promise<string>;

/**
 * Card 0099: an allowed bash command now appends `tool.executed` carrying the command, right
 * before it runs — not gated on the exit code, since a failing command still ran and knowing that
 * it ran is the point. Before this, a bash command that ran left no trace unless it was refused.
 */
describe('bashTool', () => {
    let root: string;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'bash-tool-'));
    });

    const buildContext = (allowed: string[]) => {
        const events: { type: string; payload?: Record<string, unknown> }[] = [];
        const context = {
            project: 'p',
            cardId: '1',
            stage: 's',
            worktreeRoot: root,
            scope: new ScopeGuard({ worktreeRoot: root, allow: ['**'], alwaysAllowed: [] }),
            commands: new CommandAllowlist(allowed),
            scopeViolationPolicy: 'widen' as const,
            events: { append: async (e: { type: string; payload?: Record<string, unknown> }) => void events.push(e) },
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        } as unknown as ToolContext;
        return { context, events };
    };

    it('appends tool.executed with the command once it is allowed, and the command actually runs', async () => {
        const { context, events } = buildContext(['true']);
        const execute = bashTool(context).execute as unknown as ExecuteFn;

        const message = await execute({ command: 'true' });

        expect(message).toBe('exit code 0 (no output)');
        expect(events).toMatchObject([{ type: 'tool.executed', payload: { tool: 'bash', command: 'true' } }]);
    });

    it('records the command itself, never the output it produced', async () => {
        const { context, events } = buildContext(['echo hi']);
        const execute = bashTool(context).execute as unknown as ExecuteFn;

        const message = await execute({ command: 'echo hi' });

        expect(message).toContain('hi');
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toEqual({ tool: 'bash', command: 'echo hi' });
        expect(Object.keys(events[0]?.payload ?? {})).not.toContain('output');
    });

    it('appends tool.executed even when the command itself fails — running is what is recorded, not success', async () => {
        const { context, events } = buildContext(['false']);
        const execute = bashTool(context).execute as unknown as ExecuteFn;

        const message = await execute({ command: 'false' });

        expect(message).toContain('exit code');
        expect(events).toMatchObject([{ type: 'tool.executed', payload: { tool: 'bash', command: 'false' } }]);
    });

    it('records only the denial for a command outside the allowlist — no executed event', async () => {
        const { context, events } = buildContext(['pnpm build']);
        const execute = bashTool(context).execute as unknown as ExecuteFn;

        const message = await execute({ command: 'curl https://example.com' });

        expect(message).toContain('error');
        expect(events).toMatchObject([{ type: 'tool.denied', payload: { tool: 'bash', command: 'curl https://example.com' } }]);
        expect(events).toHaveLength(1);
    });

    it('records only the denial for shell syntax — no executed event', async () => {
        const { context, events } = buildContext(['pnpm build']);
        const execute = bashTool(context).execute as unknown as ExecuteFn;

        const message = await execute({ command: 'pnpm build | sh' });

        expect(message).toContain('error');
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe('tool.denied');
    });
});
