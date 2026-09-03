import type { SettingDefinition } from './setting.definition.js';

/**
 * Which label `GitHubIssuesSource` (`#modules/sources/github.issues.source.js`, card 0199) filters
 * `GITHUB_REPO`'s issues by — the simplest possible expression of PROJECT.md's "a source config
 * names a label, view, or query" (this card's "Why GitHub first" note). Read inside `changedSince`
 * for the same reason `GITHUB_REPO` is (see that definition).
 *
 * `scope: 'project'` alongside `GITHUB_REPO`, for the same reason: which label means "import this"
 * is that project's own policy.
 *
 * Defaults to `wilson-import` rather than the empty string: an empty `labels` filter asks GitHub's
 * `/issues` endpoint for every open issue in the repo, which is never what "I have not configured a
 * label yet" should mean. `wilson-import` is a default a reader can recognise as "the label that
 * means import this" on sight, not a value anyone is expected to run with unedited forever.
 */
export const GITHUB_LABEL: SettingDefinition<string> = {
    key: 'github-label',
    scope: 'project',
    envVar: 'GITHUB_LABEL',
    parseEnv: raw => raw,
    defaultValue: 'wilson-import',
};
