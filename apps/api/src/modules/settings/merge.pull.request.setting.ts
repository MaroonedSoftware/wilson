import type { SettingDefinition } from './setting.definition.js';

/**
 * Whether Merge lands a card on GitHub as a pull request instead of moving `main` in the project
 * clone. With it on (and dry run off), `BoardWriteService.merge` proves the card against GitHub's
 * `main`, pushes the card's branch and opens a pull request, and the card waits in `ready` until
 * `PullRequestWatchJob` sees the pull request merge. Dry run wins: while it is on, Merge only
 * rehearses, whatever this says.
 *
 * Parsed identically to `DRY_RUN_ENABLED`: only `"true"` or `"1"` count as on. `defaultValue` is
 * `false`: it needs the GitHub App to hold Contents and Pull requests write permissions on the
 * project's repository, which a deployment grants on purpose.
 *
 * `scope: 'project'`, matching `DRY_RUN_ENABLED`: where a project's merges land is a property of
 * that project's repository, not of the machine running the daemon.
 */
export const MERGE_OPENS_PULL_REQUEST: SettingDefinition<boolean> = {
    key: 'merge-opens-pull-request',
    scope: 'project',
    envVar: 'MERGE_OPENS_PULL_REQUEST',
    parseEnv: raw => {
        const normalized = raw.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    },
    defaultValue: false,
};
