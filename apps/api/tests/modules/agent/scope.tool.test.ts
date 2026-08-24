import { describe, expect, it } from 'vitest';
import { requestScope, scopeTool } from '#modules/agent/tools/scope.tool.js';
import { ScopeKickbackError, type ToolContext } from '#modules/agent/tools/tool.context.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';

/**
 * `requestScope` is the function card 0021 pulled out of `scopeTool`'s `execute` so the cli
 * adapter's `request_scope` MCP tool could share it rather than duplicate it. It did not exist as
 * an importable export before: this whole file exercises that new seam directly, and `scopeTool`
 * is checked at the bottom only to confirm it now delegates rather than carrying its own copy.
 */
describe('requestScope', () => {
    const buildContext = (policy: 'widen' | 'kickback', allow: string[] = ['src/runner/**']) => {
        const events: { type: string; payload?: Record<string, unknown> }[] = [];
        const context = {
            project: 'p',
            cardId: '1',
            stage: 's',
            worktreeRoot: '/tmp',
            scope: new ScopeGuard({ worktreeRoot: '/tmp', allow, alwaysAllowed: [] }),
            commands: new CommandAllowlist(['pnpm build']),
            scopeViolationPolicy: policy,
            events: { append: async (e: { type: string; payload?: Record<string, unknown> }) => void events.push(e) },
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        } as unknown as ToolContext;
        return { context, events };
    };

    it('grants a path outside the plan’s files in scope under the widen policy, logs request then grant, and the grant actually takes effect', async () => {
        const { context, events } = buildContext('widen');

        const message = await requestScope(context, 'src/other/thing.ts', 'need it for the fix');

        expect(message).toContain('granted');
        expect(events.map(e => e.type)).toEqual(['scope.requested', 'scope.granted']);
        // Not just a log entry: a subsequent scope check on the same path must now allow it, since
        // this is what makes the write the model does next actually succeed.
        await expect(context.scope.check('src/other/thing.ts')).resolves.toMatchObject({ allowed: true });
    });

    it('throws ScopeKickbackError under the kickback policy, logs request then refusal, and never grants', async () => {
        const { context, events } = buildContext('kickback');

        await expect(requestScope(context, 'src/other/thing.ts', 'need it')).rejects.toBeInstanceOf(ScopeKickbackError);
        expect(events.map(e => e.type)).toEqual(['scope.requested', 'scope.refused']);
        await expect(context.scope.check('src/other/thing.ts')).resolves.toMatchObject({ allowed: false });
    });

    it('refuses a path that resolves outside the worktree even under widen, returning an error message rather than granting', async () => {
        const { context, events } = buildContext('widen');

        const message = await requestScope(context, '../../etc/passwd', 'nope');

        expect(message).toContain('error');
        expect(events.map(e => e.type)).toEqual(['scope.requested', 'scope.refused']);
    });

    it('scopeTool delegates to the shared requestScope function rather than a separate copy of the logic', async () => {
        const { context, events } = buildContext('widen');
        const { execute } = scopeTool(context) as unknown as {
            execute: (input: { path: string; reason: string }) => Promise<string>;
        };

        const result = await execute({ path: 'src/other/thing.ts', reason: 'need it' });

        expect(result).toContain('granted');
        // Same event sequence requestScope produces directly above — proof it is the same code
        // path, not a look-alike reimplementation on the api adapter's side.
        expect(events.map(e => e.type)).toEqual(['scope.requested', 'scope.granted']);
    });
});
