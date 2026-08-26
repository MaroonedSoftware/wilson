import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { CardStageJob } from '#modules/jobs/card.stage.job.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { captureBuildHead } from '#src/server/build.info.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import type { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import type { StageOutcome } from '#modules/stages/stage.result.js';

const exec = promisify(execFile);

const stagesYaml = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: testing
    onFail: implementing
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: review
    onFail: implementing
  - name: review
    mode: manual
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: implementing
`;

const outcome = (overrides: Partial<StageOutcome> = {}): StageOutcome => ({
    passed: true,
    failures: [],
    changedPaths: [],
    scopeGrants: [],
    transitionedTo: undefined,
    ...overrides,
});

const commit = async (codeRoot: string, contents: string, message: string): Promise<string> => {
    await writeFile(join(codeRoot, 'file.txt'), contents, 'utf8');
    await exec('git', ['add', '-A'], { cwd: codeRoot });
    await exec('git', ['commit', '-q', '-m', message], { cwd: codeRoot });
    return (await exec('git', ['rev-parse', 'HEAD'], { cwd: codeRoot })).stdout.trim();
};

/**
 * Card 0100. Deliberately the first describe in this file to touch `buildHead`: like
 * `commitsBehind`'s own "before capture" case in health.service.test.ts, `head` in build.info.ts is a
 * module-scoped, process-lifetime cache that nothing resets, and this file runs isolated per test
 * file (vitest's `pool: 'forks'`, apps/api/vitest.config.ts) — so `buildHead()` is genuinely
 * `'unknown'` here, before the describe below ever calls `captureBuildHead` in its `beforeAll`. This
 * covers `checkDaemonCurrent`'s own guard (`if (buildHead() === 'unknown') return;`,
 * card.stage.job.ts) directly: before this process has captured its own commit — the window between
 * boot and `captureBuildHead` resolving — dispatch must proceed with no staleness claim, since there
 * is nothing yet to compare `codeRoot`'s HEAD against.
 */
describe('CardStageJob before the daemon has captured its own commit (card 0100)', () => {
    it('appends no daemon.stale event and dispatches anyway', async () => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-daemon-unknown-'));
        const codeRoot = join(base, 'code');
        await mkdir(codeRoot, { recursive: true });
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await commit(codeRoot, 'one\n', 'first');

        const boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'config'), { recursive: true });
        await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml, 'utf8');

        const board = new StaticBoardConfig('test', boardRoot, codeRoot, join(base, 'worktrees'), join(base, 'run'));
        const dispatcher = { run: vi.fn(async () => outcome()) };
        const broker = { send: vi.fn(async () => 'job-1') };
        const events = { append: vi.fn(async () => {}) };
        const boardRepo = { write: vi.fn(async () => 'sha') };
        const cardJobs = { record: vi.fn(async () => {}), clear: vi.fn(async () => {}), inFlight: vi.fn(async () => undefined) };

        const job = new CardStageJob(
            dispatcher as unknown as StageDispatcher,
            broker as unknown as JobBroker,
            board,
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
        );
        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(events.append.mock.calls.map(c => c[0]).filter((e: { type: string }) => e.type === 'daemon.stale')).toEqual([]);
        expect(dispatcher.run).toHaveBeenCalledWith('0001', 'implementing');
    });
});

/**
 * Card 0100. Nothing checked, at the moment it actually mattered, whether this process was running
 * current code before it dispatched a card — `wilson doctor`'s `daemonCurrent` only ever caught it
 * when a human happened to run it, and a merge (the moment staleness is created) is the steady state
 * of a running board, not an occasional event. `CardStageJob.checkDaemonCurrent` now asks on every
 * dispatch instead.
 *
 * `captureBuildHead` pins the process's own commit once, at "boot" — module-scoped and never reset
 * (see build.info.ts) — so every case below shares one repo and one capture, made in `beforeAll`,
 * rather than each test building its own: a second `captureBuildHead` call from a fresh test's own
 * repo would be a no-op returning the *first* test's commit, comparing shas from two unrelated
 * histories. Each test instead resets the shared repo's checked-out HEAD to the specific commit its
 * scenario needs, right before dispatching — `checkDaemonCurrent` reads `codeRoot`'s HEAD live.
 */
describe('CardStageJob checks whether the daemon is current before dispatching (card 0100)', () => {
    let codeRoot: string;
    let daemonCommit: string;
    let firstSha: string;
    let fourthSha: string;

    let board: BoardConfig;
    let dispatcher: { run: ReturnType<typeof vi.fn> };
    let broker: { send: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let boardRepo: { write: ReturnType<typeof vi.fn> };
    let cardJobs: { record: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; inFlight: ReturnType<typeof vi.fn> };

    beforeAll(async () => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-daemon-stale-'));
        codeRoot = join(base, 'code');
        await mkdir(codeRoot, { recursive: true });
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });

        firstSha = await commit(codeRoot, 'one\n', 'first');
        await commit(codeRoot, 'two\n', 'second');
        // Captured once, at "boot" — everything committed after this point is what a daemon that
        // started here would not know about, exactly `captureBuildHead`'s own contract.
        daemonCommit = await captureBuildHead(codeRoot);
        await commit(codeRoot, 'three\n', 'third');
        fourthSha = await commit(codeRoot, 'four\n', 'fourth');
    });

    const buildJob = (): CardStageJob =>
        new CardStageJob(
            dispatcher as unknown as StageDispatcher,
            broker as unknown as JobBroker,
            board,
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
        );

    const daemonStaleEvents = (): unknown[] => events.append.mock.calls.map(c => c[0]).filter((e: { type: string }) => e.type === 'daemon.stale');

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-daemon-stale-board-'));
        const boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'config'), { recursive: true });
        await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml, 'utf8');

        board = new StaticBoardConfig('test', boardRoot, codeRoot, join(base, 'worktrees'), join(base, 'run'));
        dispatcher = { run: vi.fn(async () => outcome()) };
        broker = { send: vi.fn(async () => 'job-1') };
        events = { append: vi.fn(async () => {}) };
        boardRepo = { write: vi.fn(async () => 'sha') };
        cardJobs = { record: vi.fn(async () => {}), clear: vi.fn(async () => {}), inFlight: vi.fn(async () => undefined) };
    });

    it('appends daemon.stale, with both commits and how far behind, when the daemon is behind the card\'s base — and dispatches anyway', async () => {
        await exec('git', ['reset', '-q', '--hard', fourthSha], { cwd: codeRoot });

        const job = buildJob();
        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(daemonStaleEvents()).toEqual([
            expect.objectContaining({
                project: 'test',
                cardId: '0001',
                stage: 'implementing',
                type: 'daemon.stale',
                payload: { daemonCommit, baseCommit: fourthSha, behindBy: 2 },
            }),
        ]);
        expect(dispatcher.run).toHaveBeenCalledWith('0001', 'implementing');
    });

    it('appends nothing when the daemon is current with the card\'s base', async () => {
        await exec('git', ['reset', '-q', '--hard', daemonCommit], { cwd: codeRoot });

        const job = buildJob();
        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(daemonStaleEvents()).toEqual([]);
    });

    it('appends nothing when the daemon is ahead of the card\'s base — an ahead daemon is not stale', async () => {
        // The card's worktree would be cut from an older commit than the one this process is
        // running — a rebase target moved back under it, say. Compare like with like: the daemon
        // has not missed anything this base needs.
        await exec('git', ['reset', '-q', '--hard', firstSha], { cwd: codeRoot });

        const job = buildJob();
        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(daemonStaleEvents()).toEqual([]);
    });

    it('appends nothing and dispatches anyway when codeRoot cannot answer the git question at all', async () => {
        // A `codeRoot` `git rev-parse HEAD` can't answer — not a git repo — must fail the same way
        // `commitsBehind`'s own unreachable-`codeRoot` case does: "cannot tell" is not "stale", so
        // `checkDaemonCurrent`'s `baseSha` guard swallows it and dispatch proceeds untouched.
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-daemon-stale-nogit-'));
        const notGitCodeRoot = join(base, 'not-a-repo');
        await mkdir(notGitCodeRoot, { recursive: true });

        const noGitBoard = new StaticBoardConfig(
            'test',
            board.boardRoot,
            notGitCodeRoot,
            join(base, 'worktrees'),
            join(base, 'run'),
        );

        dispatcher = { run: vi.fn(async () => outcome()) };
        events = { append: vi.fn(async () => {}) };
        board = noGitBoard;
        const job = buildJob();
        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(daemonStaleEvents()).toEqual([]);
        expect(dispatcher.run).toHaveBeenCalledWith('0001', 'implementing');
    });
});
