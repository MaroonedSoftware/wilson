import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Card 0253. `cli.engine.contract.probe.ts` is not a `*.test.ts` file — the default `pnpm test`
 * never collects it, and its own `describe` blocks stay gated behind `WILSON_RUN_ENGINE_PROBES=1`
 * even under `test:engine`, per that file's own doc comment. So the only way to check what its
 * denied-bash block is actually wired to, without spending a real engine turn, is to read its
 * source directly: both runs' `maxSteps` must come from the shared `DENIED_BASH_PROBE_STEPS`
 * constant, and the probes must start the pinned binary unless told otherwise.
 */
describe('cli.engine.contract.probe.ts denied-bash block wiring', () => {
    const readSource = async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        return readFile(join(here, 'cli.engine.contract.probe.ts'), 'utf8');
    };

    it('AC3: imports DENIED_BASH_PROBE_STEPS and uses it for maxSteps, with no maxSteps: 2 left behind', async () => {
        const source = await readSource();

        expect(source).toMatch(/import\s*\{[^}]*DENIED_BASH_PROBE_STEPS[^}]*\}\s*from\s*'\.\/probe\.report\.js'/);
        expect(source).toContain('maxSteps: DENIED_BASH_PROBE_STEPS');
        expect(source).not.toContain('maxSteps: 2');
    });

    it('starts the claude on PATH and checks it is the pinned version, unless the bundled engine is asked for', async () => {
        const source = await readSource();

        expect(source).toContain("pathToClaudeCodeExecutable: 'claude'");
        expect(source).toContain("process.env.WILSON_PROBE_ENGINE === 'bundled'");
        expect(source).toContain('toBe(CLAUDE_BINARY_VERSION)');
    });
});
