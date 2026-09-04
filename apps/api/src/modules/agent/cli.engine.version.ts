/**
 * The host `claude` binary version this file's own probes (`cli.engine.contract.test.ts`,
 * `cli.tool.surface.test.ts`, both in `apps/api/tests/modules/agent/`) last passed against.
 *
 * `apps/api/package.json` pins `@anthropic-ai/claude-agent-sdk` to an exact version and this repo
 * installs it with a frozen lockfile, so that half of what `CliStageAgent` depends on cannot drift
 * out from under a card without the diff showing it (card 0231). The binary the SDK spawns is a
 * different release train entirely: installed on the operator's own machine, versioned
 * independently, upgrading itself on its own schedule — and it is exactly what broke every other
 * wrapped-CLI runner in this board's own field survey (OpenCode's SDK event drift, Gemini CLI's auth
 * changes, Claude Code's own `/pm` breakage). There is no lockfile for it, so this constant is the
 * closest equivalent: one diffable line that moves only in the same commit as a deliberate bump,
 * verified by actually running the probes above against the newer binary first.
 *
 * `packages/cli/src/checks/claude.binary.current.ts` carries its own copy of this same value rather
 * than importing it — it cannot: card 0085 dropped `packages/cli`'s dependency on `@wilson/api`
 * entirely (see that check's own comment, and `board-view.ts`'s "duplicated here, deliberately" for
 * the same reason applied elsewhere). Bump both together, in the same commit.
 */
export const CLAUDE_BINARY_VERSION = '2.1.246';
