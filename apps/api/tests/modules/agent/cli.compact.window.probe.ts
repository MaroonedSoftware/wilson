import { describe, expect, it } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscriptionEnv } from '#modules/agent/cli.stage.agent.js';

/**
 * Whether a lane's `autoCompactWindow` does what `stage.config.ts` says on the engine in use: the
 * window is honoured as the `getContextUsage` denominator, and the engine compacts near the window
 * minus 33k. Those constants were read from the 2.1.317 binary, never seen running.
 *
 * Spends real turns: about 80k of input and a summary. Run it by hand, and only this file:
 * `pnpm --filter @wilson/api test:engine tests/modules/agent/cli.compact.window.probe.ts`. It uses the
 * `claude` on PATH, or the SDK's bundled engine with `WILSON_PROBE_ENGINE=bundled`.
 */
const WINDOW = 100_000;
const COMPACTS_NEAR = WINDOW - 33_000;

/** About 20k tokens that will not compress into a cached prefix of anything else. */
const filler = (seed: string): string =>
    Array.from({ length: 6000 }, (_, line) => `${seed} line ${line}: ${(line * 2654435761) % 4294967296}`).join('\n');

describe('autoCompactWindow on the real engine', () => {
    it('compacts near the window less 33k', { timeout: 300_000 }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wilson-compact-probe-'));
        const names = ['a', 'b', 'c', 'd'];
        await Promise.all(names.map(name => writeFile(join(dir, `${name}.txt`), filler(name))));

        const stream = query({
            prompt: `Use the Read tool on ${names.map(name => `${name}.txt`).join(', ')}, one call per turn, in that order. Then reply with the word done.`,
            options: {
                cwd: dir,
                model: 'claude-haiku-5-5',
                settingSources: [],
                tools: ['Read'],
                permissionMode: 'bypassPermissions',
                allowDangerouslySkipPermissions: true,
                maxTurns: 12,
                env: { ...subscriptionEnv(), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(WINDOW) },
                ...(process.env.WILSON_PROBE_ENGINE === 'bundled' ? {} : { pathToClaudeCodeExecutable: 'claude' }),
            },
        });

        const boundaries: { trigger: string; pre_tokens: number; post_tokens?: number }[] = [];
        let maxTokens: number | undefined;
        for await (const message of stream) {
            if (message.type === 'assistant' && maxTokens === undefined) maxTokens = (await stream.getContextUsage()).maxTokens;
            if (message.type === 'system' && message.subtype === 'compact_boundary') boundaries.push(message.compact_metadata);
            if (message.type === 'result') break;
        }
        stream.close();

        console.log(JSON.stringify({ maxTokens, boundaries }));
        expect(maxTokens).toBe(WINDOW);
        expect(boundaries.length).toBeGreaterThan(0);
        expect(boundaries[0]!.trigger).toBe('auto');
        expect(boundaries[0]!.pre_tokens).toBeGreaterThanOrEqual(COMPACTS_NEAR);
    });
});
