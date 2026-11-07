import { createSign } from 'node:crypto';
import { httpError } from '@maroonedsoftware/errors';
import { DateTime, Duration } from 'luxon';

const GITHUB_API_BASE = 'https://api.github.com';
const FETCH_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;

/** GitHub refuses an app JWT that lives over ten minutes, and allows for a minute of clock drift. */
const JWT_LIFETIME = Duration.fromObject({ minutes: 9 });
const JWT_BACKDATE = Duration.fromObject({ seconds: 60 });

/** An installation token is replaced this long before it expires, so a clone never starts on a dying one. */
const TOKEN_MARGIN = Duration.fromObject({ minutes: 5 });

/**
 * Where the app's identity comes from: the `github-app-id` setting and the key in
 * `GITHUB_APP_PRIVATE_KEY_FILE`. Asked on every use, so either can be set up without a restart.
 */
export interface GitHubAppIdentity {
    appId(): Promise<string | undefined>;
    privateKey(): Promise<string | undefined>;
}

/** One repository an installation of the app can read. */
export interface GitHubAppRepository {
    fullName: string;
    private: boolean;
    defaultBranch: string;
}

/** A pull request as Wilson tracks it. `merged` is a closed pull request whose changes reached its base. */
export interface GitHubPullRequest {
    number: number;
    url: string;
    state: 'open' | 'closed' | 'merged';
    /** The commit the merge made on the base branch. Present only once `state` is `merged`. */
    mergeCommitSha?: string;
}

/** What opening a pull request needs. `head` is a branch in the same repository. */
export interface PullRequestDraft {
    head: string;
    base: string;
    title: string;
    body: string;
}

interface RawPullRequest {
    number: number;
    html_url: string;
    state: 'open' | 'closed';
    merged?: boolean;
    merged_at?: string | null;
    merge_commit_sha?: string | null;
}

const toPullRequest = (raw: RawPullRequest): GitHubPullRequest => {
    const merged = raw.merged === true || (raw.merged_at !== undefined && raw.merged_at !== null);
    return {
        number: raw.number,
        url: raw.html_url,
        state: merged ? 'merged' : raw.state,
        ...(merged && raw.merge_commit_sha ? { mergeCommitSha: raw.merge_commit_sha } : {}),
    };
};

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/**
 * Wilson's GitHub App: the signed request that proves it is the app, and the hour-long installation
 * tokens that buy, and the pull requests Merge opens with them. Each org that installs the app gets its own token, covering the repositories that
 * org chose, so nothing long-lived ever reaches git or a request for a repository.
 *
 * Hand-signed with `node:crypto` rather than through a GitHub client: one RS256 signature and a handful of
 * endpoints is all this needs. `fetchImpl` is a constructor parameter for the reason
 * `GitHubIssuesSource` gives: it is the only way this is testable without a real GitHub.
 *
 * On a deployment with no identity yet, {@link isConfigured} is false and everything else refuses
 * with a sentence an operator can act on.
 */
export class GitHubApp {
    private readonly tokens = new Map<number, { token: string; expiresAt: DateTime }>();

    constructor(
        private readonly identity: GitHubAppIdentity,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    async isConfigured(): Promise<boolean> {
        const [appId, privateKey] = await Promise.all([this.identity.appId(), this.identity.privateKey()]);
        return appId !== undefined && privateKey !== undefined;
    }

    async hasPrivateKey(): Promise<boolean> {
        return (await this.identity.privateKey()) !== undefined;
    }

    /** An installation token that can read `repository`. Refuses with 400 if the app cannot see it. */
    async tokenFor(repository: string): Promise<string> {
        const response = await this.request(`/repos/${repository}/installation`, await this.jwt());
        if (response.status === 404) {
            throw httpError(400).withDetails({ reason: `the GitHub App is not installed on ${repository}` });
        }
        await this.ensureOk(response, `looking up ${repository}`);
        const { id } = (await response.json()) as { id: number };
        return this.installationToken(id);
    }

    /** Every repository any installation of the app can read, by full name. */
    async repositories(): Promise<GitHubAppRepository[]> {
        const jwt = await this.jwt();
        const installations = await this.paged<{ id: number }>('/app/installations', jwt, body => body as { id: number }[]);
        const repositories = await Promise.all(
            installations.map(async ({ id }) => {
                const token = await this.installationToken(id);
                return this.paged<{ full_name: string; private: boolean; default_branch: string }>(
                    '/installation/repositories',
                    token,
                    body => (body as { repositories: { full_name: string; private: boolean; default_branch: string }[] }).repositories,
                );
            }),
        );
        return repositories
            .flat()
            .map(repo => ({ fullName: repo.full_name, private: repo.private, defaultBranch: repo.default_branch }))
            .sort((a, b) => a.fullName.localeCompare(b.fullName));
    }

    /**
     * Opens a pull request from `draft.head` into `draft.base`. When one is already open for that
     * head, which is what GitHub's 422 means after a crash between opening and recording it, returns
     * that one instead, so retrying a merge never opens a second.
     *
     * Needs the app's Pull requests write permission; a 403 says so.
     */
    async openPullRequest(repository: string, draft: PullRequestDraft): Promise<GitHubPullRequest> {
        const token = await this.tokenFor(repository);
        const response = await this.request(`/repos/${repository}/pulls`, token, 'POST', draft);
        if (response.status === 422) {
            const existing = await this.openPullRequestFor(repository, draft.head, token);
            if (existing) return existing;
        }
        if (response.status === 403) {
            throw httpError(503).withDetails({
                reason: `GitHub refused to open a pull request on ${repository}: the GitHub App needs the Pull requests write permission`,
            });
        }
        await this.ensureOk(response, `opening a pull request on ${repository}`);
        return toPullRequest((await response.json()) as RawPullRequest);
    }

    /** Where pull request `number` has got to. */
    async pullRequest(repository: string, number: number): Promise<GitHubPullRequest> {
        const response = await this.request(`/repos/${repository}/pulls/${number}`, await this.tokenFor(repository));
        await this.ensureOk(response, `reading pull request #${number} on ${repository}`);
        return toPullRequest((await response.json()) as RawPullRequest);
    }

    private async openPullRequestFor(repository: string, head: string, token: string): Promise<GitHubPullRequest | undefined> {
        const owner = repository.split('/')[0]!;
        const query = new URLSearchParams({ head: `${owner}:${head}`, state: 'open' });
        const response = await this.request(`/repos/${repository}/pulls?${query.toString()}`, token);
        await this.ensureOk(response, `looking for an open pull request from ${head} on ${repository}`);
        const [first] = (await response.json()) as RawPullRequest[];
        return first ? toPullRequest(first) : undefined;
    }

    private async installationToken(id: number): Promise<string> {
        const held = this.tokens.get(id);
        if (held && held.expiresAt.minus(TOKEN_MARGIN) > DateTime.now()) return held.token;

        const response = await this.request(`/app/installations/${id}/access_tokens`, await this.jwt(), 'POST');
        await this.ensureOk(response, 'asking for an installation token');
        const { token, expires_at } = (await response.json()) as { token: string; expires_at: string };
        this.tokens.set(id, { token, expiresAt: DateTime.fromISO(expires_at) });
        return token;
    }

    /** The app's own proof of identity: a short-lived RS256 JWT over its id. */
    private async jwt(): Promise<string> {
        const [appId, privateKey] = await Promise.all([this.identity.appId(), this.identity.privateKey()]);
        if (appId === undefined || privateKey === undefined) {
            throw httpError(400).withDetails({ reason: 'no GitHub App is set up: it needs an app id in Settings and a private key in place' });
        }
        const now = DateTime.now();
        const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const payload = base64url(
            JSON.stringify({
                iat: Math.floor(now.minus(JWT_BACKDATE).toSeconds()),
                exp: Math.floor(now.plus(JWT_LIFETIME).toSeconds()),
                iss: appId,
            }),
        );
        const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
        return `${header}.${payload}.${base64url(signature)}`;
    }

    /** Every page of a listing, following `Link: rel="next"`. */
    private async paged<T>(path: string, bearer: string, items: (body: unknown) => T[]): Promise<T[]> {
        const all: T[] = [];
        let url: string | undefined = `${GITHUB_API_BASE}${path}?per_page=${PAGE_SIZE}`;
        while (url) {
            const response = await this.request(url, bearer);
            await this.ensureOk(response, `listing ${path}`);
            all.push(...items(await response.json()));
            url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
        }
        return all;
    }

    private request(pathOrUrl: string, bearer: string, method = 'GET', body?: unknown): Promise<Response> {
        const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GITHUB_API_BASE}${pathOrUrl}`;
        return this.fetchImpl(url, {
            method,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            headers: {
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                Authorization: `Bearer ${bearer}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'wilson-github-app',
            },
        });
    }

    /** A status only, never the body or a token: this surfaces in chat answers and logs. */
    private async ensureOk(response: Response, doing: string): Promise<void> {
        if (!response.ok) throw httpError(503).withDetails({ reason: `GitHub answered ${response.status} ${doing}` });
    }
}
