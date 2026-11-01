import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PASSED_THROUGH, pnpmStoreLock, runConfiguredCommand, scrubbedEnv } from '#modules/stages/run.command.js';

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

    /** PROJECT.md decision 10: with any of these a stage could act as the operator. Pinned by name, in
     * case the allowlist is ever widened. */
    it("never passes wilson's own credentials to a stage command", () => {
        const keys = ['AUTH_SESSION_PRIVATE_KEY', 'AUTH_ENCRYPTION_KEY', 'WILSON_API_KEY'];
        for (const key of keys) process.env[key] = 'set-by-this-test';
        try {
            const env = scrubbedEnv();
            for (const key of keys) expect(env[key], key).toBeUndefined();
        } finally {
            for (const key of keys) delete process.env[key];
        }
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

    /**
     * Card 0027: `scrubbedEnv` grew an optional `port` argument, injected explicitly as `PORT` so a
     * dev server a stage starts does not collide with another card's. Absent whenever no range is
     * configured (the default), which every test above already exercises via `scrubbedEnv()` with no
     * argument — these cover the new argument itself.
     */
    describe('the injected PORT argument', () => {
        afterEach(() => {
            delete process.env.PORT;
        });

        it('adds no PORT when no port is given, exactly as before this argument existed', () => {
            expect(scrubbedEnv().PORT).toBeUndefined();
        });

        it('sets PORT to the given port, stringified', () => {
            expect(scrubbedEnv(4321).PORT).toBe('4321');
        });

        // The point matches `run.command.ts`'s own doc comment on this argument: the daemon's own
        // PORT, if it has one, is its own and must never leak through — only the explicitly given
        // one may appear.
        it("never leaks the parent process's own PORT through — only the explicitly given one appears", () => {
            process.env.PORT = '9999';

            expect(scrubbedEnv().PORT).toBeUndefined();
            expect(scrubbedEnv(4321).PORT).toBe('4321');
        });
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

    /**
     * Card 0027: `runConfiguredCommand` grew a fourth, optional `port` argument threaded straight
     * through to `scrubbedEnv`, so a `setupCommand` sees the same `PORT` the agent's bash tool would.
     * The daemon's own `PORT`, set here on the parent process to a different value, must never reach
     * the child — only the explicitly given one may.
     */
    it("gives the child the given port as PORT, never the parent process's own PORT", async () => {
        process.env.PORT = '9999';

        scriptDir = mkdtempSync(join(tmpdir(), 'card-0027-port-'));
        const scriptPath = join(scriptDir, 'print-port.js');
        writeFileSync(scriptPath, "console.error(process.env.PORT ?? 'unset');\nprocess.exit(1);\n");

        const failure = await runConfiguredCommand(tmpdir(), `node ${scriptPath}`, undefined, 4321);

        expect(failure).toBeDefined();
        expect(failure!.reason).toContain('4321');
        expect(failure!.reason).not.toContain('9999');

        delete process.env.PORT;
    });

    it('gives the child no PORT at all when no port is given, exactly as before this argument existed', async () => {
        scriptDir = mkdtempSync(join(tmpdir(), 'card-0027-no-port-'));
        const scriptPath = join(scriptDir, 'print-port.js');
        writeFileSync(scriptPath, "console.error(process.env.PORT ?? 'unset');\nprocess.exit(1);\n");

        const failure = await runConfiguredCommand(tmpdir(), `node ${scriptPath}`);

        expect(failure).toBeDefined();
        expect(failure!.reason).toContain('unset');
    });
});

/**
 * Card 0081 (second pass): `PnpmStoreLock.run` gained an optional fourth argument, `onWaited`, fired
 * once with the number of milliseconds a *contended* caller queued behind another — the same figure
 * its `log` callback's second message already names — so a caller that keeps a durable record of
 * what happened (`StageDispatcher`'s `worktree.prepared` event, specifically) can capture the wait
 * rather than only logging it. It must never fire for a caller that got the lock uncontended: the
 * common case, and the only case when just one stage is running (the card's own "nothing changes
 * when only one stage is running" acceptance criterion).
 */
describe('pnpmStoreLock onWaited callback', () => {
    it('fires once, only for the caller that had to queue, and never for the one already holding the lock', async () => {
        let releaseFirst!: () => void;
        const firstMayFinish = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        let firstRunning = false;

        const firstOnWaited = vi.fn();
        const secondOnWaited = vi.fn();

        const first = pnpmStoreLock.run(
            'card-0081-first',
            () => {},
            async () => {
                firstRunning = true;
                await firstMayFinish;
                return 'first-done';
            },
            firstOnWaited,
        );

        // Poll rather than sleep a fixed amount: `firstRunning` only flips true once `run` has
        // actually set `this.holder`, so once this loop exits the second call below is guaranteed to
        // see a contended lock rather than racing to find out.
        while (!firstRunning) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        const second = pnpmStoreLock.run('card-0081-second', () => {}, async () => 'second-done', secondOnWaited);

        // Give `second` a moment to actually queue behind `first` before releasing it — otherwise
        // "never called yet" would just mean "hasn't run yet", not "was never contended".
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(secondOnWaited).not.toHaveBeenCalled();

        releaseFirst();
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult).toBe('first-done');
        expect(secondResult).toBe('second-done');

        expect(firstOnWaited).not.toHaveBeenCalled();
        expect(secondOnWaited).toHaveBeenCalledTimes(1);
        expect(secondOnWaited).toHaveBeenCalledWith(expect.any(Number));
        expect(secondOnWaited.mock.calls[0]![0]).toBeGreaterThanOrEqual(0);
    });

    it('never fires when nothing else is contending for the lock', async () => {
        const onWaited = vi.fn();

        const result = await pnpmStoreLock.run('card-0081-solo', () => {}, async () => 'solo-done', onWaited);

        expect(result).toBe('solo-done');
        expect(onWaited).not.toHaveBeenCalled();
    });
});
