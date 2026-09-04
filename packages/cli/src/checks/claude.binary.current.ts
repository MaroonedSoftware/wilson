import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Check } from '@maroonedsoftware/johnny5';

const exec = promisify(execFile);

/**
 * Duplicated from `apps/api/src/modules/agent/cli.engine.version.ts` — see that constant's own
 * comment for why this package cannot import it directly (card 0085 dropped `packages/cli`'s
 * dependency on `@wilson/api` entirely; `board-view.ts` duplicates rather than imports for the same
 * reason). Bump both together, in the same commit, once `cli.engine.contract.probe.ts` has been
 * verified to pass against the newer binary.
 */
export const EXPECTED_CLAUDE_BINARY_VERSION = '2.1.246';

/** Pulls the leading `x.y.z` off `claude --version`'s output, e.g. `"2.1.246 (Claude Code)"` -> `"2.1.246"`. */
export const parseClaudeVersion = (output: string): string | undefined => output.trim().match(/^(\d+\.\d+\.\d+)/)?.[1];

/**
 * Runs the host `claude --version` and returns its raw stdout, or `undefined` when the binary isn't
 * on `PATH` (or fails to run for any other reason — this check has one thing to say about that:
 * "skipped", not a diagnosis of why).
 *
 * A separate function so `claudeBinaryCurrent` can be built against a stub of it in tests, rather
 * than mocking `node:child_process` itself — the check's own logic (parse, compare, phrase the
 * message) is what these tests are about, not how a version string gets read off the host.
 */
export const readInstalledClaudeVersion = async (): Promise<string | undefined> =>
    exec('claude', ['--version']).then(
        ({ stdout }) => stdout,
        () => undefined,
    );

/**
 * Builds the `claude binary current` check against an injectable version reader. `claudeBinaryCurrent`
 * below is this called with the real one; tests call it with a stub.
 *
 * The host `claude` binary is a release train no lockfile pins (see `CLAUDE_BINARY_VERSION`'s own
 * comment) — it upgrades itself, independently of anything `pnpm install` touches, and it is exactly
 * what broke every other wrapped-CLI runner in this board's field survey. This check makes that drift
 * visible rather than leaving it to be discovered as an unexplained probe failure days later.
 *
 * A drifted binary is a warning, not a failure — this check exists to make drift visible, not to
 * block `wilson doctor` over something an operator may not control on a shared machine. So does an
 * absent binary, or a version string this check cannot parse: those are the same "cannot answer"
 * posture `daemonCurrent` (`daemon.current.ts`) already takes, a passing skip with a reason rather
 * than a red doctor, because diagnosing the operator's install is not this check's job either.
 */
export const buildClaudeBinaryCurrent = (readVersion: () => Promise<string | undefined> = readInstalledClaudeVersion): Check => ({
    name: 'claude binary current',
    run: async () => {
        const stdout = await readVersion();
        if (stdout === undefined) {
            return { ok: true, message: 'claude binary not found on PATH; skipped' };
        }

        const version = parseClaudeVersion(stdout);
        if (version === undefined) {
            return { ok: true, message: `claude --version printed something this check could not parse (${stdout.trim()}); skipped` };
        }

        if (version !== EXPECTED_CLAUDE_BINARY_VERSION) {
            return {
                ok: true,
                message: `host claude binary is ${version}, but this board's probes last passed against ${EXPECTED_CLAUDE_BINARY_VERSION} — a warning, not a failure`,
                fixHint:
                    'Run WILSON_RUN_ENGINE_PROBES=1 pnpm --filter @wilson/api test:engine and watch cli.engine.contract.probe.ts ' +
                    '(apps/api/tests/modules/agent/). If it still passes against this binary, bump EXPECTED_CLAUDE_BINARY_VERSION here ' +
                    'and CLAUDE_BINARY_VERSION in apps/api/src/modules/agent/cli.engine.version.ts together, in the same commit.',
            };
        }

        return { ok: true, message: `claude binary is current (${version})` };
    },
});

export const claudeBinaryCurrent: Check = buildClaudeBinaryCurrent();
