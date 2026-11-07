import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Kysely } from 'kysely';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import type { Logger } from '@maroonedsoftware/logger';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import type { Card, CardPullRequest } from '#modules/board/card.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { ProjectRepository } from '#modules/board/project.repository.js';
import { PullRequestLander } from '#modules/board/pull.request.lander.js';
import { PullRequestWatcher } from '#modules/board/pull.request.watcher.js';
import type { DB } from '#modules/data/db.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { GitHubApp, GitHubPullRequest } from '#modules/github/github.app.js';
import { GitHubRemote } from '#modules/github/github.remote.js';
import { CardJobs } from '#modules/jobs/card.jobs.js';
import { RunningCards } from '#modules/jobs/running.cards.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> =>
    (await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd })).stdout.trim();

const stages = new StaticStageConfigStore(
    [
        'stages:',
        '  - name: testing',
        '    mode: agent',
        '    model: claude-opus',
        '    instructions: test the thing',
        '    onPass: merged',
        '    onFail: testing',
        '',
    ].join('\n'),
);

const logger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() }) as unknown as Logger;

const OPEN: CardPullRequest = { number: 12, url: 'https://github.com/acme/app/pull/12', state: 'open' };

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

describe('PullRequestWatcher', () => {
    let root: string;
    let github: string;
    let clone: string;
    let other: string;

    const commit = async (cwd: string, file: string): Promise<string> => {
        await writeFile(join(cwd, file), file);
        await git(cwd, 'add', file);
        await git(cwd, 'commit', '-m', file);
        return git(cwd, 'rev-parse', 'HEAD');
    };

    /** Lands a commit on GitHub's main, as merging the pull request there would. */
    const mergeOnGitHub = async (file = 'merged'): Promise<string> => {
        await git(other, 'pull', '-q', 'origin', 'main');
        const sha = await commit(other, file);
        await git(other, 'push', '-q', 'origin', 'main');
        return sha;
    };

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'pr-watcher-'));
        github = join(root, 'github.git');
        clone = join(root, 'clone');
        other = join(root, 'other');
        await git(root, 'init', '-q', '--bare', '-b', 'main', github);
        await git(root, 'clone', '-q', github, clone);
        await git(clone, 'checkout', '-q', '-b', 'main');
        await commit(clone, 'a');
        await git(clone, 'push', '-q', 'origin', 'main');
        await git(root, 'clone', '-q', github, other);
    });
    afterEach(() => rm(root, { recursive: true, force: true }));

    const setup = (answer: Partial<GitHubPullRequest> = {}, repository: string | undefined = 'acme/app') => {
        const config = new StaticBoardConfig(uniqueProject(), clone, join(root, 'wt'), join(root, 'run'));
        const events = { append: vi.fn(async () => {}), tail: vi.fn(async () => []) };
        const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        const worktrees = new WorktreeManager(config, logger());
        const broker = { send: vi.fn(async () => 'job-1'), cancel: vi.fn(async () => {}), getJob: vi.fn(async () => null) };
        const writes = new BoardWriteService(
            board,
            config,
            worktrees,
            events as unknown as EventLog,
            logger(),
            new CardJobs(config, db, broker as unknown as JobBroker),
            broker as unknown as JobBroker,
            new RunningCards(),
            { get: vi.fn(async () => false) } as unknown as SettingsStore,
            stages,
        );
        const app = {
            tokenFor: vi.fn(async () => 'token'),
            pullRequest: vi.fn(async (): Promise<GitHubPullRequest> => ({ ...OPEN, ...answer })),
        };
        const projects = {
            find: vi.fn(async () => ({ name: config.project, codeRoot: clone, worktreeRoot: '', runRoot: '', repository })),
            list: vi.fn(async () => []),
        };
        const lander = new PullRequestLander(
            app as unknown as GitHubApp,
            new GitHubRemote(app as unknown as GitHubApp, undefined, () => github),
            projects as unknown as ProjectRepository,
            config,
        );
        const watcher = new PullRequestWatcher(board, writes, lander, worktrees, config, projects as unknown as ProjectRepository, logger());
        return { board, events, app, watcher };
    };

    const waiting = (id: string, pullRequest: CardPullRequest = OPEN): Card => ({
        frontmatter: { id, title: `card ${id}`, stage: 'ready', dependsOn: [], retries: {}, pullRequest },
        sections: {},
        body: 'body',
    });

    it('leaves a card whose pull request is still open exactly where it was', async () => {
        const { board, watcher } = setup();
        await board.create(waiting('0400'), 'seed');

        await watcher.tickProject();

        const stored = await board.read('0400');
        expect(stored.frontmatter.stage).toBe('ready');
        expect(stored.frontmatter.pullRequest).toEqual(OPEN);
    });

    it('fast-forwards the clone to GitHub main, then moves the card to merged, by the runner', async () => {
        const { board, events, watcher } = setup({ state: 'merged', mergeCommitSha: 'abcdef1234' });
        await board.create(waiting('0401'), 'seed');
        const githubMain = await mergeOnGitHub();

        await watcher.tickProject();

        expect(await git(clone, 'rev-parse', 'main')).toBe(githubMain);
        expect(await git(clone, 'status', '--porcelain')).toBe('');
        const stored = await board.read('0401');
        expect(stored.frontmatter.doneReason).toBe('merged');
        expect(stored.frontmatter.pullRequest?.state).toBe('merged');
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'transition.written',
                payload: expect.objectContaining({ to: 'merged', by: 'runner', reason: expect.stringContaining('#12') }),
            }),
            expect.anything(),
        );
    });

    it('flags the card rather than merging it when the clone holds commits GitHub does not', async () => {
        const { board, watcher } = setup({ state: 'merged' });
        await board.create(waiting('0402'), 'seed');
        await mergeOnGitHub();
        const local = await commit(clone, 'local-only');

        await watcher.tickProject();

        expect(await git(clone, 'rev-parse', 'main')).toBe(local);
        const stored = await board.read('0402');
        expect(stored.frontmatter.stage).toBe('ready');
        expect(stored.frontmatter.needsHuman).toBe(true);
        expect(stored.frontmatter.needsHumanReason).toContain('could not follow');
        expect(stored.frontmatter.pullRequest?.state).toBe('merged');
    });

    it('records a pull request closed without merging and flags the card', async () => {
        const { board, events, watcher } = setup({ state: 'closed' });
        await board.create(waiting('0403'), 'seed');

        await watcher.tickProject();

        const stored = await board.read('0403');
        expect(stored.frontmatter.stage).toBe('ready');
        expect(stored.frontmatter.pullRequest?.state).toBe('closed');
        expect(stored.frontmatter.needsHuman).toBe(true);
        expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'card.pull-request-closed' }), expect.anything());
    });

    it('asks GitHub nothing when no card is waiting on a pull request', async () => {
        const { board, app, watcher } = setup({ state: 'merged' });
        await board.create(waiting('0404', { ...OPEN, state: 'closed' }), 'seed');

        await watcher.tickProject();

        expect(app.pullRequest).not.toHaveBeenCalled();
    });

    it('keeps going past a card GitHub cannot answer for', async () => {
        const { board, app, watcher } = setup();
        app.pullRequest.mockRejectedValueOnce(new Error('GitHub answered 502')).mockResolvedValueOnce({ ...OPEN, number: 13, state: 'closed' });
        await board.create(waiting('0405'), 'seed');
        await board.create(waiting('0406', { ...OPEN, number: 13 }), 'seed');

        await watcher.tickProject();

        expect((await board.read('0406')).frontmatter.pullRequest?.state).toBe('closed');
        expect((await board.read('0405')).frontmatter.pullRequest?.state).toBe('open');
    });
});
