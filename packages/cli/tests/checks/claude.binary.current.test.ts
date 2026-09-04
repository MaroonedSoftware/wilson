import { describe, expect, it } from 'vitest';
import { EXPECTED_CLAUDE_BINARY_VERSION, buildClaudeBinaryCurrent, parseClaudeVersion } from '#src/checks/claude.binary.current.js';

/**
 * Card 0231. The host `claude` binary is a release train no lockfile pins — it upgrades itself,
 * independently of anything `pnpm install` touches, and it is exactly what broke every other
 * wrapped-CLI runner in this board's own field survey. This check makes that drift visible.
 *
 * Built against a stub of `readInstalledClaudeVersion` rather than mocking `node:child_process`:
 * what these tests are about is this check's own logic — parse, compare, phrase the message — not
 * how a version string gets off the host, which `readInstalledClaudeVersion` itself has no branches
 * worth a unit test for.
 *
 * Per the Constraints, a drifted binary is a warning, not a failure — `daemonCurrent`'s own posture
 * for "cannot answer" (no binary, unparseable output) extended here to cover a genuine version
 * mismatch too, since this check exists to make drift visible, not to block `wilson doctor` over
 * something an operator may not control. So every case below passes (`ok: true`); only the message
 * (and, for drift, the fixHint) differs.
 */
describe('claudeBinaryCurrent', () => {
    it('passes, naming the version, when the host binary matches what the probes last passed against', async () => {
        const check = buildClaudeBinaryCurrent(async () => `${EXPECTED_CLAUDE_BINARY_VERSION} (Claude Code)`);

        const result = await check.run({} as never);

        expect(result).toEqual({ ok: true, message: `claude binary is current (${EXPECTED_CLAUDE_BINARY_VERSION})` });
    });

    it('warns, naming both versions, when the host binary has drifted — but still passes', async () => {
        const check = buildClaudeBinaryCurrent(async () => '9.9.9 (Claude Code)');

        const result = await check.run({} as never);

        expect(result.ok).toBe(true);
        expect(result.message).toContain('9.9.9');
        expect(result.message).toContain(EXPECTED_CLAUDE_BINARY_VERSION);
        expect(result.message).toContain('a warning, not a failure');
        expect(result.fixHint).toContain('cli.engine.contract.test.ts');
    });

    it('reports a passing skip, naming the reason, when no binary is on PATH', async () => {
        const check = buildClaudeBinaryCurrent(async () => undefined);

        const result = await check.run({} as never);

        expect(result).toEqual({ ok: true, message: 'claude binary not found on PATH; skipped' });
    });

    it('reports a passing skip, quoting what it saw, when the version string cannot be parsed', async () => {
        const check = buildClaudeBinaryCurrent(async () => 'not a version at all');

        const result = await check.run({} as never);

        expect(result.ok).toBe(true);
        expect(result.message).toContain('could not parse');
        expect(result.message).toContain('not a version at all');
    });
});

describe('parseClaudeVersion', () => {
    it('pulls the leading x.y.z off the real CLI’s own output shape', () => {
        expect(parseClaudeVersion('2.1.246 (Claude Code)')).toBe('2.1.246');
    });

    it('returns undefined for output with no version at the front', () => {
        expect(parseClaudeVersion('command not found')).toBeUndefined();
    });
});
