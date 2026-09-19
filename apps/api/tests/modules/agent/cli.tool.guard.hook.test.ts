import { describe, expect, it } from 'vitest';
import { createToolGuard, toolGuardHook } from '#modules/agent/cli.stage.agent.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import type { ToolContext } from '#modules/agent/tools/index.js';

/**
 * Card 0249. `toolGuardHook` adapts `createToolGuard`'s `CanUseTool` into a `PreToolUse` hook
 * callback, so the guard's decision reaches the engine through the one event it calls
 * unconditionally — see `cli.stage.agent.ts`'s class doc comment for the 2026-09-19 finding this
 * exists to fix (host engine 2.1.266 sometimes never calls `canUseTool` at all).
 *
 * Tested directly against the adapter, the same way `cli.tool.guard.test.ts` exercises
 * `createToolGuard` directly: a live model declining to misbehave proves the model's judgement,
 * not the hook's mapping or the dedup it has to preserve now that the guard is reached two ways.
 */
describe('toolGuardHook', () => {
    const build = (worktree: string, allow: string[] = ['src/runner/**'], commands: string[] = ['pnpm build']) => {
        const denied: Record<string, unknown>[] = [];
        const executed: Record<string, unknown>[] = [];
        const context = {
            project: 'p',
            cardId: '1',
            stage: 's',
            worktreeRoot: '/tmp',
            scope: new ScopeGuard({ worktreeRoot: '/tmp', allow, alwaysAllowed: [] }),
            commands: new CommandAllowlist(commands),
            scopeViolationPolicy: 'widen' as const,
            events: {
                append: async (e: { type: string; payload?: Record<string, unknown> }) => {
                    if (e.type === 'tool.denied') denied.push(e.payload ?? {});
                    if (e.type === 'tool.executed') executed.push(e.payload ?? {});
                },
            },
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        } as unknown as ToolContext;
        const guard = createToolGuard(context, worktree);
        return { guard, hook: toolGuardHook(guard), denied, executed };
    };

    const hookOpts = { signal: new AbortController().signal };
    const preToolUse = (toolName: string, input: Record<string, unknown>, toolUseId: string) =>
        ({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: input, tool_use_id: toolUseId }) as never;

    it('AC1: denies a Bash command the stage’s allowlist refuses, carrying the guard’s own message as the reason', async () => {
        const { hook } = build('rw');
        const result = await hook(preToolUse('Bash', { command: 'curl https://example.com' }, 'toolu_1'), 'toolu_1', hookOpts);
        expect(result).toMatchObject({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: "command is not in this stage's allowlist. Allowed: pnpm build.",
            },
        });
    });

    it('AC2: allows a Write inside the plan’s files in scope', async () => {
        const { hook } = build('rw');
        const result = await hook(preToolUse('Write', { file_path: '/tmp/src/runner/new.ts' }, 'toolu_2'), 'toolu_2', hookOpts);
        expect(result).toMatchObject({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
        });
    });

    it('AC3: denies a tool the guard does not recognise, matching its default-deny', async () => {
        const { hook } = build('rw');
        const result = await hook(preToolUse('WebFetch', { url: 'https://example.com' }, 'toolu_3'), 'toolu_3', hookOpts);
        expect(result).toMatchObject({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'WebFetch is not available to this stage',
            },
        });
    });

    it('passes any hook event that is not PreToolUse straight through, untouched', async () => {
        const { hook } = build('rw');
        const result = await hook({ hook_event_name: 'PostToolUse' } as never, 'toolu_4', hookOpts);
        expect(result).toEqual({ continue: true });
    });

    describe('AC4: one guard instance reached two ways must not pay for a decision twice', () => {
        it('records a deny once when the same toolUseID is consulted through the hook and then again through canUseTool', async () => {
            const { guard, hook, denied } = build('rw');
            const hookResult = await hook(preToolUse('Bash', { command: 'curl https://example.com' }, 'toolu_1'), 'toolu_1', hookOpts);
            // The backstop consultation the engine would make if the hook did not short-circuit it —
            // same toolUseID, same call, reached the other door.
            const backstopResult = await guard('Bash', { command: 'curl https://example.com' }, {
                toolUseID: 'toolu_1',
                signal: hookOpts.signal,
            } as never);

            expect(hookResult).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
            expect(backstopResult).toMatchObject({ behavior: 'deny' });
            expect(denied).toHaveLength(1);
        });

        it('replays the cached decision on the second consultation rather than re-deciding, so the repeat-refusal counter does not sharpen it', async () => {
            const { guard, hook } = build('rw');
            await hook(preToolUse('Bash', { command: 'curl https://example.com' }, 'toolu_1'), 'toolu_1', hookOpts);
            const second = await guard('Bash', { command: 'curl https://example.com' }, {
                toolUseID: 'toolu_1',
                signal: hookOpts.signal,
            } as never);
            expect((second as { message: string }).message).not.toContain('time this has been refused');
            expect((second as { message: string }).message).toBe("command is not in this stage's allowlist. Allowed: pnpm build.");
        });

        it('records tool.executed once for an allowed call consulted through both doors', async () => {
            const { guard, hook, executed } = build('rw');
            await hook(preToolUse('Write', { file_path: '/tmp/src/runner/new.ts' }, 'toolu_2'), 'toolu_2', hookOpts);
            await guard('Write', { file_path: '/tmp/src/runner/new.ts' }, { toolUseID: 'toolu_2', signal: hookOpts.signal } as never);
            expect(executed).toEqual([{ tool: 'Write', path: 'src/runner/new.ts' }]);
        });

        it('still decides independently for two different toolUseIDs, so the cache is keyed by id and not just by call shape', async () => {
            const { guard, denied } = build('rw');
            await guard('Bash', { command: 'curl https://example.com' }, { toolUseID: 'toolu_a', signal: hookOpts.signal } as never);
            await guard('Bash', { command: 'curl https://example.com' }, { toolUseID: 'toolu_b', signal: hookOpts.signal } as never);
            expect(denied).toHaveLength(2);
        });
    });
});
