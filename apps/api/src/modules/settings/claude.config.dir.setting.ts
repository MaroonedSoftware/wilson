import type { SettingDefinition } from './setting.definition.js';

/**
 * The Claude config directory (`~/.claude` by convention) the engine authenticates from — card
 * 0141's answer to "whose credentials does the engine use": a database row overriding the
 * `CLAUDE_CONFIG_DIR` environment variable overriding "unset", the same precedence every other
 * setting in this table follows (`SettingsStore.get`).
 *
 * Before this card nothing in the repo named `CLAUDE_CONFIG_DIR` at all, so the engine always fell
 * back to whatever lives in the home directory of the user the daemon happens to run as —
 * `subscriptionEnv` (`modules/agent/cli.stage.agent.ts`) is where a resolved value here actually
 * reaches the engine's environment. Unset (`defaultValue: undefined`) means exactly that unchanged
 * behaviour, not an invented default like `~/.claude` (this card's Constraints: "no default path, no
 * inventing `~/.claude` in code").
 *
 * `parseEnv` is the identity function, the same posture `NOTIFY_WEBHOOK_URL` takes and for the same
 * reason: an environment-configured value was never write-validated, so staying lenient here keeps a
 * deployment that sets `CLAUDE_CONFIG_DIR` directly booting exactly as it did before this card.
 * Judging the value — must be an absolute path — is `ClaudeConfigDirSettingService.set`'s job, run
 * only at write, never here.
 */
export const CLAUDE_CONFIG_DIR: SettingDefinition<string | undefined> = {
    key: 'claude-config-dir',
    envVar: 'CLAUDE_CONFIG_DIR',
    parseEnv: raw => raw,
    defaultValue: undefined,
};
