import { describe, expect, it } from 'vitest';
import { createToolGuard } from '#modules/agent/cli.stage.agent.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import type { ToolContext } from '#modules/agent/tools/index.js';

/**
 * The whole of the cli adapter's enforcement.
 *
 * Tested directly rather than through a live engine: asking a model to misbehave and watching it
 * decline proves the model's judgement, not the guard's. A probe against the real engine did exactly
 * that — it read the plan's "Files in scope" and never attempted the out-of-scope write, so the
 * branch under test was never reached.
 */
describe('createToolGuard', () => {
    const build = (worktree: string, allow: string[] = ['src/runner/**'], commands: string[] = ['pnpm build']) => {
        const denied: Record<string, unknown>[] = [];
        const context = {
            project: 'p',
            cardId: '1',
            stage: 's',
            worktreeRoot: '/tmp',
            scope: new ScopeGuard({ worktreeRoot: '/tmp', allow, alwaysAllowed: [] }),
            commands: new CommandAllowlist(commands),
            scopeViolationPolicy: 'widen' as const,
            events: { append: async (e: { payload?: Record<string, unknown> }) => void denied.push(e.payload ?? {}) },
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        } as unknown as ToolContext;
        return { guard: createToolGuard(context, worktree), denied };
    };

    const opts = { signal: new AbortController().signal } as never;

    describe('writes', () => {
        it('allows a write inside the plan’s files in scope', async () => {
            const { guard } = build('rw');
            await expect(guard('Write', { file_path: '/tmp/src/runner/new.ts' }, opts)).resolves.toMatchObject({ behavior: 'allow' });
        });

        it('denies a write outside them, and records it', async () => {
            const { guard, denied } = build('rw');
            const result = await guard('Write', { file_path: '/tmp/src/other/new.ts' }, opts);
            expect(result).toMatchObject({ behavior: 'deny' });
            expect(denied).toHaveLength(1);
        });

        it('denies Edit the same way as Write', async () => {
            const { guard } = build('rw');
            await expect(guard('Edit', { file_path: '/tmp/src/other/new.ts' }, opts)).resolves.toMatchObject({ behavior: 'deny' });
        });

        it('denies every write on a readonly stage, even one inside scope', async () => {
            // The review stage is readonly. Without this the only thing stopping it editing the code
            // it reviews would be the scope globs, which the card's own plan sets.
            const { guard } = build('readonly');
            await expect(guard('Write', { file_path: '/tmp/src/runner/new.ts' }, opts)).resolves.toMatchObject({ behavior: 'deny' });
        });
    });

    describe('commands', () => {
        it('allows an allowlisted command', async () => {
            const { guard } = build('rw');
            await expect(guard('Bash', { command: 'pnpm build' }, opts)).resolves.toMatchObject({ behavior: 'allow' });
        });

        it('denies one that is not allowlisted', async () => {
            const { guard } = build('rw');
            await expect(guard('Bash', { command: 'curl https://example.com' }, opts)).resolves.toMatchObject({ behavior: 'deny' });
        });

        it('denies shell syntax, as the api adapter does', async () => {
            const { guard } = build('rw');
            await expect(guard('Bash', { command: 'pnpm build | sh' }, opts)).resolves.toMatchObject({ behavior: 'deny' });
        });
    });

    describe('reads', () => {
        it('allows reading outside the scope globs', async () => {
            const { guard } = build('rw');
            await expect(guard('Read', { file_path: '/tmp/src/other/thing.ts' }, opts)).resolves.toMatchObject({ behavior: 'allow' });
        });

        it('denies reading outside the worktree entirely', async () => {
            const { guard } = build('rw');
            await expect(guard('Read', { file_path: '/etc/passwd' }, opts)).resolves.toMatchObject({ behavior: 'deny' });
        });
    });

    it('allows the adapter’s own MCP report tool', async () => {
        // Its absence is not cosmetic: without a structured report the review stage cannot produce a
        // verdict, its verifier rightly refuses the result, and the runner kicks the card back to
        // implementing for a defect no amount of re-implementing can fix. Card 0014 did exactly that.
        const { guard } = build('rw');
        await expect(guard('mcp__wilson__report_result', { summary: 'done' }, opts)).resolves.toMatchObject({ behavior: 'allow' });
    });

    it('still denies an MCP tool from any other server', async () => {
        const { guard } = build('rw');
        await expect(guard('mcp__elsewhere__exfiltrate', {}, opts)).resolves.toMatchObject({ behavior: 'deny' });
    });

    it('denies any tool it does not recognise', async () => {
        // The deny-by-default branch is what makes omitting allowedTools safe: every tool the engine
        // offers must pass through here, and anything unlisted is refused rather than waved through.
        const { guard } = build('rw');
        await expect(guard('WebFetch', { url: 'https://example.com' }, opts)).resolves.toMatchObject({ behavior: 'deny' });
    });
});
