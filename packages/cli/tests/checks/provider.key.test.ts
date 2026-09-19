import { describe, expect, it } from 'vitest';
import { providerKeySet } from '#src/checks/provider.key.js';

/**
 * Card 0247. `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`XAI_API_KEY` come from `apps/api/.env`, which
 * johnny5 loads into `ctx.env`, not `ctx.config`. The `ctx` below carries only `env` — no `config`
 * at all — so a check that still reached for `ctx.config.get` would throw here.
 */
describe('providerKeySet', () => {
    it('passes and names the key when ANTHROPIC_API_KEY is set only in ctx.env (AC3)', async () => {
        const ctx = { env: { ANTHROPIC_API_KEY: 'sk-ant-test' } } as never;

        const result = await providerKeySet.run(ctx);

        expect(result).toEqual({ ok: true, message: 'ANTHROPIC_API_KEY' });
    });

    it('names every configured key, not just the first, when more than one is set', async () => {
        const ctx = { env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-oai-test' } } as never;

        const result = await providerKeySet.run(ctx);

        expect(result).toEqual({ ok: true, message: 'ANTHROPIC_API_KEY, OPENAI_API_KEY' });
    });

    it('still fails with today’s message and fix hint when no key is set (AC6)', async () => {
        const ctx = { env: {} } as never;

        const result = await providerKeySet.run(ctx);

        expect(result).toEqual({
            ok: false,
            message: 'no provider key configured',
            fixHint: 'Set ANTHROPIC_API_KEY (or OPENAI_API_KEY / XAI_API_KEY) in apps/api/.env.',
        });
    });
});
