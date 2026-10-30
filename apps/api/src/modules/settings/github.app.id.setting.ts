import type { SettingDefinition } from './setting.definition.js';

/**
 * The GitHub App this deployment acts as (`GitHubApp`). Not a secret, unlike the private key that
 * goes with it, which stays in a file (`GITHUB_APP_PRIVATE_KEY_FILE`). Read on every use, so setting
 * it needs no restart.
 *
 * `scope: 'deployment'`: one app serves every project, and which repositories it reaches is decided
 * by where it is installed.
 */
export const GITHUB_APP_ID: SettingDefinition<string | undefined> = {
    key: 'github-app-id',
    scope: 'deployment',
    envVar: 'GITHUB_APP_ID',
    parseEnv: raw => raw.trim(),
    defaultValue: undefined,
};
