import { describe, expect, it, vi } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import type { ProjectRepository } from '#modules/board/project.repository.js';
import { PullRequestLander, pullRequestBody, pullRequestTitle } from '#modules/board/pull.request.lander.js';
import type { GitHubApp } from '#modules/github/github.app.js';
import type { GitHubRemote } from '#modules/github/github.remote.js';

const card = (goal?: string): Card => ({
    frontmatter: { id: '0042', title: 'Do a thing', stage: 'ready', dependsOn: [], retries: {} },
    sections: goal === undefined ? {} : { Goal: goal },
    body: '',
});

describe('PullRequestLander', () => {
    const config = new StaticBoardConfig('wilson', '/code', '/wt', '/run');

    const lander = (repository?: string) => {
        const calls: string[] = [];
        const remote = {
            fetchBranch: vi.fn(async () => 'github-main-sha'),
            push: vi.fn(async () => {
                calls.push('push');
            }),
        };
        const app = {
            openPullRequest: vi.fn(async () => {
                calls.push('open');
                return { number: 12, url: 'https://github.com/acme/app/pull/12', state: 'open' as const };
            }),
        };
        const projects = { find: vi.fn(async () => ({ name: 'wilson', codeRoot: '/code', worktreeRoot: '/wt', runRoot: '/run', repository })) };
        return {
            calls,
            remote,
            app,
            lander: new PullRequestLander(
                app as unknown as GitHubApp,
                remote as unknown as GitHubRemote,
                projects as unknown as ProjectRepository,
                config,
            ),
        };
    };

    it("answers the current project's repository, or nothing for one registered by path", async () => {
        expect(await lander('acme/app').lander.repository()).toBe('acme/app');
        expect(await lander().lander.repository()).toBeUndefined();
    });

    it("fetches GitHub main into the clone's tracking ref", async () => {
        const { lander: subject, remote } = lander('acme/app');

        expect(await subject.fetchBase('acme/app')).toEqual({ ref: 'refs/remotes/origin/main', sha: 'github-main-sha' });
        expect(remote.fetchBranch).toHaveBeenCalledWith('/code', 'acme/app', 'main');
    });

    it('pushes the proven commit before opening the pull request into main', async () => {
        const { lander: subject, calls, remote, app } = lander('acme/app');

        const pr = await subject.open('acme/app', card('Make it work.'), 'card/0042', 'branch-sha');

        expect(calls).toEqual(['push', 'open']);
        expect(remote.push).toHaveBeenCalledWith('/code', 'acme/app', 'branch-sha', 'card/0042');
        expect(app.openPullRequest).toHaveBeenCalledWith('acme/app', {
            head: 'card/0042',
            base: 'main',
            title: '0042: Do a thing',
            body: expect.stringContaining('Make it work.'),
        });
        expect(pr).toEqual({ number: 12, url: 'https://github.com/acme/app/pull/12', state: 'open' });
    });
});

describe('pull request text', () => {
    it('titles it with the card id and title', () => {
        expect(pullRequestTitle(card())).toBe('0042: Do a thing');
    });

    it("carries the card's Goal and where it came from", () => {
        const body = pullRequestBody(card('Make it work.'), 'card/0042');

        expect(body).toContain('## Goal\n\nMake it work.');
        expect(body).toContain('card 0042, branch `card/0042`');
    });

    it('says only where it came from when the card has no Goal', () => {
        expect(pullRequestBody(card(), 'card/0042')).toBe('Opened by Wilson from card 0042, branch `card/0042`.');
    });

    it('stays under GitHub’s body limit for a very long Goal', () => {
        expect(pullRequestBody(card('x'.repeat(100_000)), 'card/0042').length).toBeLessThan(65_536);
    });
});
