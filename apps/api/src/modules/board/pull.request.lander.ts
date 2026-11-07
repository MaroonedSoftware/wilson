import { Injectable } from 'injectkit';
import { GitHubApp, type GitHubPullRequest } from '#modules/github/github.app.js';
import { GitHubRemote, githubTrackingRef } from '#modules/github/github.remote.js';
import { BoardConfig } from './board.config.js';
import type { Card, CardPullRequest } from './card.js';
import { ProjectRepository } from './project.repository.js';

/** The branch every pull request Merge opens targets, as every other merge in Wilson does. */
export const PULL_REQUEST_BASE = 'main';

/** How much of the card's Goal goes into a pull request's body, which GitHub caps at 65536. */
const MAX_GOAL = 60_000;

/** A pull request's title: the card's id and title, the same words the board shows. */
export const pullRequestTitle = (card: Card): string => `${card.frontmatter.id}: ${card.frontmatter.title}`;

/** A pull request's body: the card's Goal, then where it came from. */
export const pullRequestBody = (card: Card, branch: string): string => {
    const goal = card.sections.Goal?.trim();
    const from = `Opened by Wilson from card ${card.frontmatter.id}, branch \`${branch}\`.`;
    if (!goal) return from;
    const trimmed = goal.length > MAX_GOAL ? `${goal.slice(0, MAX_GOAL)}\n\n…` : goal;
    return `## Goal\n\n${trimmed}\n\n---\n\n${from}`;
};

export const toCardPullRequest = (pr: GitHubPullRequest): CardPullRequest => ({ number: pr.number, url: pr.url, state: pr.state });

/**
 * The GitHub side of Merge for a project that lands merges as pull requests: where the project's
 * repository is, bringing GitHub's `main` into the clone to prove against, and pushing the card's
 * branch with a pull request over it.
 *
 * Its own class rather than more of `BoardWriteService` so the write service needs one optional
 * collaborator, not four, and a test can stand in for all of GitHub at once.
 */
@Injectable()
export class PullRequestLander {
    constructor(
        private readonly app: GitHubApp,
        private readonly remote: GitHubRemote,
        private readonly projects: ProjectRepository,
        private readonly config: BoardConfig,
    ) {}

    /** The current project's GitHub repository, or undefined for a project registered by path. */
    async repository(): Promise<string | undefined> {
        return (await this.projects.find(this.config.project))?.repository;
    }

    /**
     * Fetches GitHub's `main` into the clone and returns the ref it now sits at, for Merge to prove
     * against. The clone's own `main` does not move.
     */
    async fetchBase(repository: string): Promise<{ ref: string; sha: string }> {
        const sha = await this.remote.fetchBranch(this.config.codeRoot, repository, PULL_REQUEST_BASE);
        return { ref: githubTrackingRef(PULL_REQUEST_BASE), sha };
    }

    /** Pushes `branchSha` to `branch` on GitHub and opens (or finds) its pull request into `main`. */
    async open(repository: string, card: Card, branch: string, branchSha: string): Promise<CardPullRequest> {
        await this.remote.push(this.config.codeRoot, repository, branchSha, branch);
        const pr = await this.app.openPullRequest(repository, {
            head: branch,
            base: PULL_REQUEST_BASE,
            title: pullRequestTitle(card),
            body: pullRequestBody(card, branch),
        });
        return toCardPullRequest(pr);
    }

    /** Where pull request `number` has got to on GitHub. */
    async read(repository: string, number: number): Promise<GitHubPullRequest> {
        return this.app.pullRequest(repository, number);
    }
}
