import { mkdtemp, writeFile } from 'node:fs/promises';
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

    /**
     * Card 0027: `bashTool` now runs the child with `scrubbedEnv(ctx.port)` instead of
     * `scrubbedEnv()`, so a dev server the agent starts through this tool sees the same `PORT` a
     * `setupCommand` run by `StageDispatcher` would. `ctx.port` is `StageDispatcher`'s allocated
     * port for this stage's worktree — plumbed straight from `ToolContext`, which this test controls
     * directly rather than going through the dispatcher.
     */
    describe('the PORT the child process sees (card 0027)', () => {
        it('is the value of ctx.port when the stage was given one', async () => {
            const { context } = buildContext([`node ${join(root, 'print-port.js')}`]);
            await writeFile(join(root, 'print-port.js'), "console.log(process.env.PORT ?? 'unset');\n");
            (context as unknown as { port?: number }).port = 4321;
            const execute = bashTool(context).execute as unknown as ExecuteFn;

            const message = await execute({ command: `node ${join(root, 'print-port.js')}` });

            expect(message.trim()).toBe('4321');
        });

        it('is unset when ctx.port is undefined — the default for a stage with no configured range', async () => {
            const { context } = buildContext([`node ${join(root, 'print-port-unset.js')}`]);
            await writeFile(join(root, 'print-port-unset.js'), "console.log(process.env.PORT ?? 'unset');\n");
            // buildContext never sets `port`, so ToolContext.port is undefined here, exactly the
            // shape every stage without a configured DEV_SERVER_PORT_RANGE has.
            const execute = bashTool(context).execute as unknown as ExecuteFn;

            const message = await execute({ command: `node ${join(root, 'print-port-unset.js')}` });

            expect(message.trim()).toBe('unset');
        });
    });
});
