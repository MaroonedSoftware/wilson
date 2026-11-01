import type { SettingDefinition } from './setting.definition.js';

/**
 * The token engines on this machine sign in with, as opposed to the ones Wilson assigns to worker hosts, saved from the board so that changing it needs no
 * restart. The one secret in `wilson.settings`, so its row holds ciphertext.
 *
 * Read with `SettingsStore.stored`, never `get`, whose fallback would hand back the environment
 * variable's plaintext where the caller expects ciphertext. `EngineTokenSettingService` is the only
 * reader and writer. `subscriptionEnv` already passes the environment's own token to the engine, so
 * that side of the usual precedence needs nothing from here.
 *
 * `scope: 'deployment'`, for the reason `CLAUDE_CONFIG_DIR` is: this names one machine's credential,
 * not one project's policy.
 */
export const ENGINE_TOKEN: SettingDefinition<string | undefined> = {
    key: 'engine-oauth-token',
    scope: 'deployment',
    envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
    parseEnv: raw => raw,
    defaultValue: undefined,
};
