import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { CardStageJob } from '#modules/jobs/card.stage.job.js';
import { RunningCards, type RunningCard } from '#modules/jobs/running.cards.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import type { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import type { StageOutcome } from '#modules/stages/stage.result.js';

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

const stageConfigs = new StaticStageConfigStore(stagesYaml);

const outcome = (overrides: Partial<StageOutcome> = {}): StageOutcome => ({
    passed: true,
    failures: [],
    changedPaths: [],
    scopeGrants: [],
    ...overrides,
});

/**
 * Card 0066. `CardStageJob.run` now records, in a shared `RunningCards`, which card this process's
 * handler is inside `run()` for — the thing a bounded shutdown needs in order to name what it would
 * be abandoning instead of reporting a false clean stop. These tests exercise that tracking directly:
 * the card must show up in `RunningCards` for the duration of the dispatcher call, and must come back
 * out again once the handler settles, on every path `run()` can take (success, permanent failure,
 * transient failure).
 */
describe('CardStageJob tracks cards in flight via RunningCards', () => {
    let board: BoardConfig;
    let dispatcher: { run: ReturnType<typeof vi.fn> };
    let broker: { send: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let boardRepo: { write: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };
    let cardJobs: { record: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; inFlight: ReturnType<typeof vi.fn> };
    let running: RunningCards;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-running-'));

        board = new StaticBoardConfig('test', join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        dispatcher = { run: vi.fn(async () => outcome()) };
        broker = { send: vi.fn(async () => 'job-1') };
        events = { append: vi.fn(async () => {}) };
        // Card 0104: `deferOnScopeConflict` reads the card first; a rejected read is treated the same
        // as "nothing to defer" (see its doc comment in predispatch/scope.conflict.ts), so the new check falls
        // straight through and these tests exercise `RunningCards` exactly as before.
        boardRepo = {
            write: vi.fn(async () => 'sha'),
            read: vi.fn(async () => {
                throw new Error('not stubbed');
            }),
        };
        cardJobs = { record: vi.fn(async () => {}), clear: vi.fn(async () => {}), inFlight: vi.fn(async () => undefined) };
        running = new RunningCards();
    });

    const buildJob = () =>
        new CardStageJob(
            dispatcher as unknown as StageDispatcher,
            broker as unknown as JobBroker,
            board,
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
            stageConfigs,
            running,
        );

    it('shows the card as running for exactly the window the dispatcher is executing', async () => {
        let snapshotDuringRun: RunningCard[] = [];
        dispatcher.run.mockImplementation(async () => {
            snapshotDuringRun = running.snapshot();
            return outcome();
        });
        const snapshotBeforeRun = running.snapshot();
        const job = buildJob();

        await job.run({ cardId: '0042', stageName: 'implementing' });

        expect(snapshotBeforeRun).toEqual([]);
        expect(snapshotDuringRun).toEqual([{ project: 'test', cardId: '0042' }]);
    });

    it('removes the card once the handler settles normally', async () => {
        const job = buildJob();

        await job.run({ cardId: '0042', stageName: 'implementing' });

        expect(running.snapshot()).toEqual([]);
    });

    it('removes the card after a permanent failure poisons it', async () => {
        dispatcher.run.mockImplementation(async () => {
            throw new Error('Your credit balance is too low to access the Anthropic API.');
        });
        const job = buildJob();

        await job.run({ cardId: '0042', stageName: 'implementing' });

        expect(running.snapshot()).toEqual([]);
    });

    it('removes the card even when the stage throws transiently and the run() promise rejects', async () => {
        dispatcher.run.mockImplementation(async () => {
            throw new Error('socket hang up');
        });
        const job = buildJob();

        await expect(job.run({ cardId: '0042', stageName: 'implementing' })).rejects.toThrow('socket hang up');

        expect(running.snapshot()).toEqual([]);
    });
});

/**
 * `RunningCards` in isolation: the tracker `CardStageJob` and `jobs.module.ts`'s shutdown path both
 * depend on. A shutdown that gave up on more than one wedged handler needs every card id it holds,
 * not just the most recent one, so it has to key by card rather than hold a single slot.
 */
describe('RunningCards', () => {
    it('tracks more than one card id at a time, independently', () => {
        const running = new RunningCards();
        running.add('proj-a', '0001');
        running.add('proj-a', '0002');

        expect([...running.snapshot()].sort((a, b) => a.cardId.localeCompare(b.cardId))).toEqual([
            { project: 'proj-a', cardId: '0001' },
            { project: 'proj-a', cardId: '0002' },
        ]);

        running.delete('proj-a', '0001');

        expect(running.snapshot()).toEqual([{ project: 'proj-a', cardId: '0002' }]);
    });

    it('delete is a no-op for a card that was never added', () => {
        const running = new RunningCards();

        expect(() => running.delete('proj-a', '0099')).not.toThrow();
        expect(running.snapshot()).toEqual([]);
    });

    /**
     * Card 0149: entries are keyed by `(project, cardId)`, not `cardId` alone — two projects' `0001`s
     * running at once must be two distinct entries, and deleting one must not touch the other.
     */
    it("keeps two different projects' same-numbered card ids as distinct entries", () => {
        const running = new RunningCards();
        running.add('project-a', '0001');
        running.add('project-b', '0001');

        expect([...running.snapshot()].sort((a, b) => a.project.localeCompare(b.project))).toEqual([
            { project: 'project-a', cardId: '0001' },
            { project: 'project-b', cardId: '0001' },
        ]);

        running.delete('project-a', '0001');

        expect(running.snapshot()).toEqual([{ project: 'project-b', cardId: '0001' }]);
    });
});
