import type { SettingDefinition } from './setting.definition.js';

/**
 * Which repo `GitHubIssuesSource` (`#modules/sources/github.issues.source.js`, card 0199) imports
 * issues from, as `owner/name` — e.g. `octocat/hello-world`. Read inside `changedSince`, not cached
 * anywhere: that class is a process-wide singleton and `changedSince` runs inside `runAsProject`, so
 * a value read at construction would be whichever project happened to be current at boot (this
 * card's Constraints).
 *
 * `parseEnv` is the identity function, the same reason `NOTIFY_WEBHOOK_URL` gives
 * (`notify.webhook.url.setting.ts`): validating the shape — `owner/name`, no scheme, no path
 * traversal, no query string — is `GitHubIssuesSource`'s own job, at the point it is about to be
 * interpolated into a request URL, not this definition's.
 *
 * `scope: 'project'` (the same reasoning `NOTIFY_WEBHOOK_URL` gives for its own project scope): which
 * repo a project imports from is that project's own policy, not the deployment's — a second project
 * on the same deployment points at its own repo, not this one's, without a restart.
 *
 * No useful default: an operator who has not configured a repo has not configured anything to import
 * from, and `GitHubIssuesSource` only exists in the registry at all when `SourcesModule` has already
 * seen `GITHUB_TOKEN` and `GITHUB_REPO` both set at boot (this card's Constraints) — `undefined` here
 * is unreachable in practice, but kept honest rather than defaulting to an invalid placeholder.
 */
export const GITHUB_REPO: SettingDefinition<string | undefined> = {
    key: 'github-repo',
    scope: 'project',
    envVar: 'GITHUB_REPO',
    parseEnv: raw => raw,
    defaultValue: undefined,
};
