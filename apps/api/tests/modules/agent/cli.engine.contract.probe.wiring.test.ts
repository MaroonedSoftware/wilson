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
 * constant, and the control run's expected message must be derived from `stepsExceeded`, not a
 * hand-written string that could quietly drift from the constant it is supposed to describe.
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

    it('AC4: derives the control run\'s expected message from stepsExceeded, with no hand-written "2 steps" string', async () => {
        const source = await readSource();

        expect(source).toMatch(/import\s*\{[^}]*stepsExceeded[^}]*\}\s*from\s*'#modules\/agent\/budget\.js'/);
        expect(source).toContain('stepsExceeded(DENIED_BASH_PROBE_STEPS, 0)');
        expect(source).not.toContain('step budget exceeded: 2 steps');
    });
});
