import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { CardStageJob } from '#modules/jobs/card.stage.job.js';
import { PRE_DISPATCH_CHECKS } from '#modules/jobs/predispatch/index.js';
import { checkDaemonCurrent } from '#modules/jobs/predispatch/daemon.current.js';
import { captureBuildHead } from '#src/server/build.info.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { StageDispatcher } from '#modules/stages/stage.dispatcher.js';

const exec = promisify(execFile);

const stagesYaml = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: merged
    onFail: implementing
`;

const stageConfigs = new StaticStageConfigStore(stagesYaml);

/**
 * `checkDaemonCurrent` (card 0100) and `deferOnScopeConflict` (card 0104) arrived as separate cards
 * and made the identical edit to `CardStageJob`: a call at the top of `runStage`, a method at the
 * bottom of the class. They are now a list, and the list has an ordering contract worth more than
 * the convenience — one check only observes, the other can stop the dispatch, and the observer has
 * to go first.
 *
 * A card deferred for a scope conflict on a stale daemon must still leave the `daemon.stale` record
 * behind: that is a fact about this process, not about this card, and losing it would mean a board
 * whose daemon is behind stops saying so precisely when several cards are contending. Reversing
 * `PRE_DISPATCH_CHECKS` is what this catches.
 */
describe('pre-dispatch checks run in a defined order', () => {
    let codeRoot: string;
    let board: BoardConfig;

    beforeAll(async () => {
        const base = await mkdtemp(join(tmpdir(), 'predispatch-order-'));
        codeRoot = join(base, 'code');
        await mkdir(codeRoot, { recursive: true });
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });

        const commit = async (contents: string, message: string) => {
            await writeFile(join(codeRoot, 'file.txt'), contents, 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', message], { cwd: codeRoot });
        };

        await commit('one\n', 'first');
        // "Boot": everything committed after this is what this daemon does not know about.
        await captureBuildHead(codeRoot);
        await commit('two\n', 'second');
        await commit('three\n', 'third');

        board = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
    });

    it('records the daemon as stale even when a later check stops the dispatch', async () => {
        const dispatcher = { run: vi.fn() };
        const events = { append: vi.fn(async () => {}) };
        const cardJobs = { record: vi.fn(async () => {}), clear: vi.fn(async () => {}), inFlight: vi.fn(async () => undefined) };
        const boardRepo = {
            write: vi.fn(async () => 'sha'),
            read: vi.fn(async () => ({ frontmatter: { title: 'A card', stage: 'implementing' }, body: '' })),
            scopeConflict: vi.fn(async () => ({ cardId: '0002', overlap: [{ ours: 'src/a.ts', theirs: 'src/a.ts' }] })),
        };

        const job = new CardStageJob(
            dispatcher as unknown as StageDispatcher,
            { send: vi.fn(async () => 'job-1') } as unknown as JobBroker,
            board,
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
            stageConfigs,
        );
        await job.run({ cardId: '0001', stageName: 'implementing' });

        const types = events.append.mock.calls.map(c => (c[0] as { type: string }).type);

        // The observer ran and recorded, before the check that stopped everything.
        expect(types).toContain('daemon.stale');
        expect(types).toContain('dispatch.deferred');
        expect(types.indexOf('daemon.stale')).toBeLessThan(types.indexOf('dispatch.deferred'));

        // And the dispatch genuinely stopped: no worktree was ever going to be cut.
        expect(dispatcher.run).not.toHaveBeenCalled();
        expect(cardJobs.clear).toHaveBeenCalledWith('0001');
    });

    it('puts the check that only observes ahead of every check that can stop a dispatch', () => {
        expect(PRE_DISPATCH_CHECKS[0]).toBe(checkDaemonCurrent);
    });
});
