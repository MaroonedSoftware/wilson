import { describe, expect, it } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { generateKinds, judgeDrift, readAdapterReads, readBaseline, writeBaseline } from '#tests/support/codex.protocol.js';

const exec = promisify(execFile);

/**
 * Whether a build of each engine still speaks the way the adapters expect, with no account, key or
 * model call, so a nightly job can ask it of the newest release as well as the pinned one
 * (`.github/workflows/engine-compat.yml`).
 *
 * This does not replace the live probes: it says nothing about what an engine does during a turn, so
 * it cannot see a guard being skipped.
 *
 * - `WILSON_ENGINE_COMPAT=1`: turns these on. `test:engine` otherwise skips them.
 * - `CLAUDE_PROBE_BIN`, `CODEX_PROBE_BIN`: the binaries. With the check on, a missing one fails: a
 *   check that could not run is not a pass.
 * - `CODEX_KINDS_UPDATE=1`: rewrites the baseline from `CODEX_PROBE_BIN`, for a version bump. Read the
 *   diff: each new kind is a decision about the adapter.
 */
const enabled = process.env.WILSON_ENGINE_COMPAT === '1';
const HANDSHAKE_MS = 60_000;

const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set, so this check could not run`);
    return value;
};

/** A home of its own, so no sign-in or setting of the operator's can change the answer. */
const isolated = async (prefix: string): Promise<{ home: string; env: NodeJS.ProcessEnv }> => {
    const home = await mkdtemp(join(tmpdir(), prefix));
    return { home, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home } };
};

/** A prompt that never arrives: the handshake needs an open session, and no model call may follow. */
async function* noPrompt(): AsyncGenerator<never> {
    await new Promise(() => {});
}

describe.runIf(enabled)('claude: the pinned SDK against this binary', () => {
    it(
        'completes the handshake and lists models',
        async () => {
            const binary = required('CLAUDE_PROBE_BIN');
            const { home, env } = await isolated('claude-compat-');
            const { stdout } = await exec(binary, ['--version'], { env });
            const session = query({
                prompt: noPrompt(),
                options: { pathToClaudeCodeExecutable: binary, cwd: home, env, settingSources: [] },
            });
            try {
                const init = await Promise.race([
                    session.initializationResult(),
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no handshake within ${HANDSHAKE_MS}ms`)), HANDSHAKE_MS)),
                ]);
                console.info(`claude ${stdout.trim()}: ${init.models.length} models`);
                expect(init.models.length).toBeGreaterThan(0);
            } finally {
                session.close();
            }
        },
        HANDSHAKE_MS + 10_000,
    );
});

describe.runIf(enabled)('codex: the protocol this binary declares', () => {
    it('has not drifted in a way the adapter would get wrong', async () => {
        const binary = required('CODEX_PROBE_BIN');
        const { home, env } = await isolated('codex-compat-');
        const { stdout } = await exec(binary, ['--version'], { env });
        const version = stdout.trim().split(/\s+/).at(-1)!;
        const kinds = await generateKinds(binary, join(home, 'generated'), env);

        if (process.env.CODEX_KINDS_UPDATE === '1') {
            await writeBaseline(version, kinds);
            return;
        }

        const baseline = await readBaseline();
        const drift = judgeDrift(baseline, kinds, await readAdapterReads());
        console.info(`codex ${version} against the ${baseline.version} baseline: ${drift.notes.join('; ') || 'no notes'}`);
        expect(drift.failures).toEqual([]);
    });
});
