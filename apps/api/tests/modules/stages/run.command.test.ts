import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PASSED_THROUGH, runConfiguredCommand, scrubbedEnv } from '#modules/stages/run.command.js';

/**
 * Card 0045: `runConfiguredCommand` used to call `execFile` with no `env`, so a `setupCommand`,
 * `buildCommand` or `testCommand` inherited the whole server process's environment — provider keys,
 * database URLs, and whatever else launched it. It now shares `bash.tool.ts`'s allowlisted
 * `scrubbedEnv`, exported from this module so both call sites use one definition.
 */
describe('scrubbedEnv', () => {
    const SECRET_KEY = '__CARD_0045_SECRET__';

    afterEach(() => {
        delete process.env[SECRET_KEY];
    });

    it('drops a variable that is not on the allowlist', () => {
        process.env[SECRET_KEY] = 'super-secret-value';
        expect(scrubbedEnv()[SECRET_KEY]).toBeUndefined();
    });

    it('keeps every allowlisted variable that is actually set', () => {
        const env = scrubbedEnv();
        for (const key of PASSED_THROUGH) {
            if (process.env[key] !== undefined) {
                expect(env[key]).toBe(process.env[key]);
            }
        }
    });

    it('only ever contains allowlisted keys plus the injected CI flag', () => {
        process.env[SECRET_KEY] = 'super-secret-value';
        const env = scrubbedEnv();
        const allowed = new Set([...PASSED_THROUGH, 'CI']);
        for (const key of Object.keys(env)) {
            expect(allowed.has(key)).toBe(true);
        }
    });

    it('injects CI=true regardless of the parent process', () => {
        expect(scrubbedEnv().CI).toBe('true');
    });
});

describe('runConfiguredCommand environment', () => {
    const SECRET_KEY = '__CARD_0045_LEAK_PROBE__';
    // `runConfiguredCommand` parses its command with a plain whitespace split (there is no shell to
    // interpret quoting), so the probe has to be a script file rather than an inline `node -e`.
    let scriptDir: string;

    afterEach(() => {
        delete process.env[SECRET_KEY];
        if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
    });

    it('does not hand a non-allowlisted variable to the child process', async () => {
        process.env[SECRET_KEY] = 'this-must-not-leak';

        scriptDir = mkdtempSync(join(tmpdir(), 'card-0045-leak-probe-'));
        const scriptPath = join(scriptDir, 'probe.js');
        // Fails on purpose so its stderr — and therefore whether the secret leaked — ends up in the
        // returned failure reason, which is the only window `runConfiguredCommand` gives onto the
        // child's actual environment.
        writeFileSync(scriptPath, `console.error(process.env.${SECRET_KEY} ? 'LEAKED' : 'CLEAN');\nprocess.exit(1);\n`);

        const failure = await runConfiguredCommand(tmpdir(), `node ${scriptPath}`);

        expect(failure).toBeDefined();
        expect(failure!.reason).toContain('CLEAN');
        expect(failure!.reason).not.toContain('LEAKED');
    });

    it('still passes through PATH, so an allowlisted binary like node runs at all', async () => {
        scriptDir = mkdtempSync(join(tmpdir(), 'card-0045-runs-'));
        const scriptPath = join(scriptDir, 'ok.js');
        writeFileSync(scriptPath, 'process.exit(0);\n');

        const failure = await runConfiguredCommand(tmpdir(), `node ${scriptPath}`);
        expect(failure).toBeUndefined();
    });
});
