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
        // The counterpart to `denied`: every `tool.executed` payload the guard appends on an allow,
        // kept separate so the existing denial assertions below don't have to filter it out.
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
        return { guard: createToolGuard(context, worktree), denied, executed };
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

        it('records tool.executed for an allowed write, naming the tool and path', async () => {
            // The review-found gap: Write/Edit here run through the engine's own built-in tools and
            // this guard, not through file.tools.ts, so this is the only point that can record what
            // actually got written when the stage runs through the cli adapter.
            const { guard, executed } = build('rw');
            await guard('Write', { file_path: '/tmp/src/runner/new.ts' }, opts);
            expect(executed).toEqual([{ tool: 'Write', path: 'src/runner/new.ts' }]);
        });

        it('records tool.executed for an allowed edit too', async () => {
            const { guard, executed } = build('rw');
            await guard('Edit', { file_path: '/tmp/src/runner/new.ts' }, opts);
            expect(executed).toEqual([{ tool: 'Edit', path: 'src/runner/new.ts' }]);
        });

        it('does not record tool.executed when the write is denied', async () => {
            const { guard, executed } = build('rw');
            await guard('Write', { file_path: '/tmp/src/other/new.ts' }, opts);
            expect(executed).toHaveLength(0);
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

        it('records tool.executed for an allowed command, carrying the command and not its output', async () => {
            // This guard only ever sees the proposed call, never the exit code — bash.tool.ts can
            // afford to note "a failing command still ran"; this callback can't distinguish that at
            // all, so it records on allow, the only moment it has.
            const { guard, executed } = build('rw');
            await guard('Bash', { command: 'pnpm build' }, opts);
            expect(executed).toEqual([{ tool: 'Bash', command: 'pnpm build' }]);
        });

        it('does not record tool.executed when the command is denied', async () => {
            const { guard, executed } = build('rw');
            await guard('Bash', { command: 'curl https://example.com' }, opts);
            expect(executed).toHaveLength(0);
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

        it('never records tool.executed for a read, allowed or denied', async () => {
            // card.event.ts's whole reason for excluding reads: hundreds of them per stage would
            // swamp card_events. This guard's allow branch for READ_TOOLS must stay silent.
            const { guard, executed } = build('rw');
            await guard('Read', { file_path: '/tmp/src/other/thing.ts' }, opts);
            await guard('Read', { file_path: '/etc/passwd' }, opts);
            expect(executed).toHaveLength(0);
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

    describe('repeat denials', () => {
        // Card 0083: three real runs burned turns retrying `find` after an identical denial, because
        // the message never changed on the retry. The guard now tracks how many times each denial
        // *shape* has fired in the life of one guard and sharpens the message from the second refusal
        // on, without altering the underlying reason it is built from.

        it('leaves the first refusal of a shape exactly as the allowlist/scope reason phrased it', async () => {
            const { guard } = build('rw');
            const result = await guard('Bash', { command: 'find / -iname stages.yaml' }, opts);
            expect(result).toMatchObject({ behavior: 'deny' });
            expect((result as { message: string }).message).toBe(
                'find is not available, and does not need to be — use the glob tool (pass include_ignored to reach node_modules).',
            );
        });

        it('prefixes the second identical-shaped refusal with a repeat notice, and still names the tool', async () => {
            const { guard } = build('rw');
            await guard('Bash', { command: 'find / -iname stages.yaml' }, opts);
            const second = await guard('Bash', { command: 'find . -iname stages.yaml' }, opts);

            const message = (second as { message: string }).message;
            expect(message).toContain('2nd time this has been refused in this run');
            expect(message).toContain('repeating it will not produce a different answer');
            // The original reason must still be present, appended after the notice — the agent loses
            // nothing it had on the first denial.
            expect(message).toContain('use the glob tool (pass include_ignored to reach node_modules)');
        });

        it('counts a third refusal as 3rd, not 2nd again', async () => {
            const { guard } = build('rw');
            await guard('Bash', { command: 'find / -name a' }, opts);
            await guard('Bash', { command: 'find / -name b' }, opts);
            const third = await guard('Bash', { command: 'find / -name c' }, opts);
            expect((third as { message: string }).message).toContain('3rd time this has been refused in this run');
        });

        it('does not carry the repeat count over to a differently-shaped denial', async () => {
            const { guard } = build('rw');
            await guard('Bash', { command: 'find / -name stages.yaml' }, opts);
            // Same tool, unrelated command — a fresh shape, so this is its own first offense.
            const result = await guard('Bash', { command: 'curl https://example.com' }, opts);
            const message = (result as { message: string }).message;
            expect(message).not.toContain('time this has been refused');
            expect(message).toBe("command is not in this stage's allowlist. Allowed: pnpm build.");
        });

        it('records the sharpened message on the event, not just the returned deny', async () => {
            const { guard, denied } = build('rw');
            await guard('Bash', { command: 'find / -name a' }, opts);
            await guard('Bash', { command: 'find / -name b' }, opts);
            expect(denied[1]?.reason).toContain('2nd time this has been refused in this run');
        });

        it('keeps repeat counts private to one guard instance', async () => {
            // createToolGuard is called fresh per stage run; a second call (a different stage, or a
            // retry of the same one) must not inherit another run's history.
            const first = build('rw');
            await first.guard('Bash', { command: 'find / -name a' }, opts);
            await first.guard('Bash', { command: 'find / -name b' }, opts);

            const second = build('rw');
            const freshResult = await second.guard('Bash', { command: 'find / -name a' }, opts);
            expect((freshResult as { message: string }).message).not.toContain('time this has been refused');
        });
    });
});
