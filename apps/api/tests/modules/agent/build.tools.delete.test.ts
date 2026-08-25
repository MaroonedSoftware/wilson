import { describe, expect, it } from 'vitest';
import { buildTools } from '#modules/agent/tools/index.js';
import type { ToolContext } from '#modules/agent/tools/tool.context.js';
import { z } from 'zod';

/**
 * Card 0086 added `delete` to the api adapter's tool set, wired into `buildTools` next to
 * `write`/`edit`/`request_scope`: present only when `worktreeMode` is `'rw'`, physically absent from
 * the returned object otherwise — the same drop `write`/`edit`/`request_scope` already get, and for
 * the same reason (a readonly/none stage should not have the tool to call in the first place, not
 * just be denied when it tries).
 *
 * A minimal stand-in `ToolContext` is enough here: `buildTools` only wraps `ctx` in closures at this
 * stage, it never calls into it, so nothing about the tool's own behaviour needs a real worktree.
 */
describe('buildTools delete gating', () => {
    const fakeCtx = { worktreeRoot: '/tmp' } as unknown as ToolContext;
    const resultSchema = z.object({ summary: z.string().optional() });

    it('includes delete alongside write, edit and request_scope for an rw stage', () => {
        const tools = buildTools(fakeCtx, resultSchema, 'rw');

        expect(tools).toHaveProperty('delete');
        expect(tools).toHaveProperty('write');
        expect(tools).toHaveProperty('request_scope');
    });

    it.each(['readonly', 'none'] as const)('omits delete entirely for a %s worktree mode, not just leaving it to deny', mode => {
        const tools = buildTools(fakeCtx, resultSchema, mode);

        expect(tools).not.toHaveProperty('delete');
        expect(tools).not.toHaveProperty('write');
        expect(tools).not.toHaveProperty('request_scope');
    });
});
