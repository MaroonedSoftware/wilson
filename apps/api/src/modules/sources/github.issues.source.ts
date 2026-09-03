import { GITHUB_LABEL } from '#modules/settings/github.label.setting.js';
import { GITHUB_REPO } from '#modules/settings/github.repo.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import type { CardSource, CardSourceFetchResult, CardSourceItem } from './card.source.js';

/** How long one page fetch waits before it is abandoned. Follows `UrlContextProvider`'s
 * `FETCH_TIMEOUT_MS` (`#modules/context/url.context.provider.js`) — a fixed number, not an unbounded
 * wait, applied to every page fetched, not just the first. */
const FETCH_TIMEOUT_MS = 15_000;

/** How many bytes of one page's response body this source will read before refusing the rest.
 * Enforced while reading, not after — `UrlContextProvider`'s own reasoning for why
 * `await response.text()` is unsafe applies here too. */
const MAX_CONTENT_BYTES = 2_000_000;

/** How many pages of `Link: rel="next"` this source follows before it stops, even if GitHub keeps
 * offering another. A poll that never terminates because a repo has thousands of matching issues
 * would starve every other registered source and project this same tick — see this card's
 * acceptance criteria. */
const MAX_PAGES = 10;

const GITHUB_API_BASE = 'https://api.github.com';

/** Only the fields this source reads out of a GitHub issue payload — everything else (assignees,
 * milestone, reactions, comments) is out of this card's scope by name in its Constraints. */
type GitHubIssuePayload = {
    readonly number: number;
    readonly title: string;
    readonly body: string | null;
    readonly updated_at: string;
    /** Present (with any value) on a pull request — GitHub's `/issues` endpoint returns pull
     * requests as issues, and this is the tell this card's Constraints name as "the single most
     * likely defect in the card". */
    readonly pull_request?: unknown;
};

/** `owner/name` only: no scheme, no path traversal, no query string, no more or fewer than one
 * slash. Deliberately conservative rather than GitHub's own (looser) rules for what a login or repo
 * name may contain — this card's Constraints ask only that the string be safe to interpolate into a
 * URL path, not that it accept everything GitHub itself would. */
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * The first `CardSource` (`#modules/sources/card.source.js`, card 0196) that talks to anything real:
 * GitHub Issues, filtered to one repo and one label, both read fresh out of `SettingsStore` on every
 * call (`GITHUB_REPO`, `GITHUB_LABEL`) rather than cached at construction — see those definitions'
 * own doc comments for why.
 *
 * `SourcesModule` constructs this with the deployment's `GITHUB_TOKEN` only when it and `GITHUB_REPO`
 * are both set in the environment at boot — this class itself never reads `AppConfig` and never
 * decides whether it should exist, per this card's Constraints ("the token comes from `AppConfig`
 * only, never a settings row").
 *
 * `fetchImpl`, `timeoutMs`, and `maxContentBytes` are constructor parameters defaulting to the real
 * `fetch` and the constants above, the same reason `UrlContextProvider` gives for the identical
 * trio: it is the only way this class is testable without a real GitHub.
 *
 * No SSRF destination check, deliberately (this card's Constraints): `UrlContextProvider` reuses
 * `checkWebhookDestination` because its URL is operator-supplied in full, but here the host is the
 * constant `GITHUB_API_BASE` and the operator supplies only a path segment — `validateRepo` below is
 * what stands in its place, refusing anything that is not a bare `owner/name` before a request is
 * ever built.
 */
export class GitHubIssuesSource implements CardSource {
    readonly name = 'github';

    constructor(
        private readonly settings: SettingsStore,
        private readonly token: string,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly timeoutMs: number = FETCH_TIMEOUT_MS,
        private readonly maxContentBytes: number = MAX_CONTENT_BYTES,
    ) {}

    async changedSince(cursor: string | undefined): Promise<CardSourceFetchResult> {
        const repo = await this.settings.get(GITHUB_REPO);
        if (!repo) {
            return { ok: false, reason: 'GITHUB_REPO is not configured for this project' };
        }
        const repoCheck = this.validateRepo(repo);
        if (!repoCheck.ok) return repoCheck;

        const label = await this.settings.get(GITHUB_LABEL);
        // An empty incoming cursor and an undefined one mean the same thing to this source — "since
        // the beginning" — so a previously-persisted `''` (see the no-items branch at the bottom)
        // round-trips to the same request as the very first call ever made.
        const since = cursor && cursor.length > 0 ? cursor : undefined;

        const items: CardSourceItem[] = [];
        let latestUpdatedAt: string | undefined;
        let url: string | undefined = this.buildUrl(repo, label, since);
        let pages = 0;

        while (url && pages < MAX_PAGES) {
            pages += 1;
            const page = await this.fetchPage(url);
            if (!page.ok) return page;

            for (const issue of page.issues) {
                // The `/issues` endpoint returns pull requests as issues; `pull_request` is the only
                // field that tells them apart (this card's Constraints).
                if ('pull_request' in issue) continue;
                items.push({ externalId: `${repo}#${issue.number}`, title: issue.title, body: issue.body ?? '' });
                if (!latestUpdatedAt || issue.updated_at > latestUpdatedAt) latestUpdatedAt = issue.updated_at;
            }

            url = page.next;
        }

        // The newest issue reported is reported again next poll (`since` is inclusive), which
        // `InboundCardWriter` makes idempotent — this card's Constraints, and [[0197]]'s whole
        // reason to exist. `since` itself (not `undefined`) is what "reported none" falls back to,
        // satisfying `CardSourceFetchResult`'s `cursor: string` even on the very first call.
        return { ok: true, items, cursor: latestUpdatedAt ?? since ?? '' };
    }

    /** `owner/name` only. Called before any request is built — a bad repo string must never reach a
     * URL, not merely fail the request that would have used it. */
    private validateRepo(repo: string): { ok: true } | { ok: false; reason: string } {
        if (!REPO_PATTERN.test(repo)) {
            return { ok: false, reason: `GITHUB_REPO "${repo}" is not a valid "owner/name" repo` };
        }
        return { ok: true };
    }

    private buildUrl(repo: string, label: string, since: string | undefined): string {
        const params = new URLSearchParams({ labels: label, state: 'open', sort: 'updated', direction: 'asc', per_page: '100' });
        if (since !== undefined) params.set('since', since);
        // `repo` has already passed `validateRepo`: letters, digits, `.`, `_`, `-`, and exactly one
        // `/`, so no further encoding is needed for the path segment itself.
        return `${GITHUB_API_BASE}/repos/${repo}/issues?${params.toString()}`;
    }

    /**
     * One page: the parsed issue array and the next page's URL, if `Link` offered one, or a refusal
     * naming what happened — non-2xx (with the status), a body over the cap, a timeout, or an
     * unparseable payload. Never throws (this card's Constraints), and never puts `this.token` in
     * the reason it returns — `SourcePoller` logs a refusal's `reason` verbatim.
     */
    private async fetchPage(
        url: string,
    ): Promise<{ ok: true; issues: readonly GitHubIssuePayload[]; next: string | undefined } | { ok: false; reason: string }> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetchImpl(url, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'wilson-card-sources',
                },
                signal: controller.signal,
            });

            if (!response.ok) {
                return { ok: false, reason: `GitHub issues request for "${url}" returned ${response.status}` };
            }

            const read = await this.readBounded(response);
            if (!read.ok) {
                return { ok: false, reason: `GitHub issues response for "${url}" exceeds the ${this.maxContentBytes}-byte limit` };
            }

            let payload: unknown;
            try {
                payload = JSON.parse(read.text);
            } catch {
                return { ok: false, reason: `GitHub issues response for "${url}" was not valid JSON` };
            }
            if (!Array.isArray(payload)) {
                return { ok: false, reason: `GitHub issues response for "${url}" was not a JSON array` };
            }

            return { ok: true, issues: payload as GitHubIssuePayload[], next: this.parseNextLink(response.headers.get('link')) };
        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                return { ok: false, reason: `GitHub issues request for "${url}" timed out after ${this.timeoutMs}ms` };
            }
            return { ok: false, reason: `GitHub issues request for "${url}" failed: ${(error as Error).message}` };
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Reads `response`'s body up to `maxContentBytes`, refusing (and cancelling the underlying
     * stream) the moment that cap is crossed rather than after the whole body has been buffered.
     * Mirrors `UrlContextProvider.readBounded` — duplicated rather than imported, since this card's
     * "Files in scope" does not reach into `modules/context/`.
     */
    private async readBounded(response: Response): Promise<{ ok: true; text: string } | { ok: false }> {
        const reader = response.body?.getReader();
        if (!reader) return { ok: true, text: '' };

        const decoder = new TextDecoder();
        let text = '';
        let bytes = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > this.maxContentBytes) {
                await reader.cancel();
                return { ok: false };
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return { ok: true, text };
    }

    /** The `rel="next"` URL out of a `Link` header (RFC 8288), or `undefined` when there is none —
     * the last page, or a response with no `Link` header at all. */
    private parseNextLink(header: string | null): string | undefined {
        if (!header) return undefined;
        for (const part of header.split(',')) {
            const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
            if (match) return match[1];
        }
        return undefined;
    }
}
