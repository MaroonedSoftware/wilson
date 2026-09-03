import { describe, expect, it } from 'vitest';
import { GITHUB_REPO } from '#modules/settings/github.repo.setting.js';

/**
 * Card 0199. `GITHUB_REPO` is the `SettingDefinition` `GitHubIssuesSource.changedSince` resolves for
 * which repo to import from, read fresh every call rather than cached at construction (that class's
 * own doc comment explains why).
 */
describe('GITHUB_REPO', () => {
    it('is keyed github-repo, scoped per project, reads GITHUB_REPO, and defaults to undefined', () => {
        expect(GITHUB_REPO.key).toBe('github-repo');
        expect(GITHUB_REPO.scope).toBe('project');
        expect(GITHUB_REPO.envVar).toBe('GITHUB_REPO');
        expect(GITHUB_REPO.defaultValue).toBeUndefined();
    });

    // Unlike `POLLER_INTERVAL_MS`, validating the shape is `GitHubIssuesSource`'s job, at the point
    // it is about to be interpolated into a URL — `parseEnv` here is a plain passthrough, the same
    // as `NOTIFY_WEBHOOK_URL`'s.
    it('parseEnv passes the raw string through unchanged', () => {
        expect(GITHUB_REPO.parseEnv('octocat/hello-world')).toBe('octocat/hello-world');
        expect(GITHUB_REPO.parseEnv('../../etc')).toBe('../../etc');
    });
});
