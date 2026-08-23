import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { CardStageJob } from '#modules/jobs/card.stage.job.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import type { StageOutcome } from '#modules/stages/stage.result.js';

const stagesYaml = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: testing
    onFail: needs-human
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
    ...overrides,
});

describe('CardStageJob', () => {
    let board: BoardConfig;
    let dispatcher: { run: ReturnType<typeof vi.fn> };
    let broker: { send: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let boardRepo: { write: ReturnType<typeof vi.fn> };
    let job: CardStageJob;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-'));
        const boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'config'), { recursive: true });
        await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml, 'utf8');

        board = new StaticBoardConfig('test', boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        dispatcher = { run: vi.fn(async () => outcome()) };
        broker = { send: vi.fn(async () => {}) };
        events = { append: vi.fn(async () => {}) };
        boardRepo = { write: vi.fn(async () => 'sha') };

        job = new CardStageJob(
            dispatcher as unknown as StageDispatcher,
            broker as unknown as JobBroker,
            board,
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
        );
    });

    it('does nothing when the dispatcher leaves the stage un-transitioned (a manual gate)', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: undefined }));

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(broker.send).not.toHaveBeenCalled();
        expect(events.append).not.toHaveBeenCalled();
    });

    it('enqueues the next stage when the card lands on another agent stage', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'testing' }));

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'testing' });
        expect(events.append).not.toHaveBeenCalled();
    });

    it('re-enqueues on a kickback to an earlier agent stage rather than treating it as terminal', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'implementing' }));

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'implementing' });
    });

    it('stops and records a chain.stopped event when the card lands on a manual stage', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'review' }));

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(broker.send).not.toHaveBeenCalled();
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                project: 'test',
                cardId: '0001',
                stage: 'testing',
                type: 'chain.stopped',
                payload: { target: 'review', reason: expect.stringContaining('manual') },
            }),
        );
    });

    it('stops and records a chain.stopped event when the card lands on a terminal state', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'merged' }));

        await job.run({ cardId: '0001', stageName: 'review' });

        expect(broker.send).not.toHaveBeenCalled();
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'review',
                type: 'chain.stopped',
                payload: { target: 'merged', reason: expect.stringContaining('terminal state') },
            }),
        );
    });

    it('runs the requested stage through the dispatcher with the card id and stage name given', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: undefined }));

        await job.run({ cardId: '0042', stageName: 'implementing' });

        expect(dispatcher.run).toHaveBeenCalledWith('0042', 'implementing');
    });

    describe('permanent failures', () => {
        // pg-boss retries a thrown job. That is right for a timeout and pure waste for an exhausted
        // balance, which this project watched burn three retry cycles — each one cutting a worktree
        // and installing dependencies before failing at the first model call.
        it('poisons the card and does not throw, so the queue does not retry', async () => {
            dispatcher.run = vi.fn(async () => {
                throw new Error('Your credit balance is too low to access the Anthropic API.');
            });

            await expect(job.run({ cardId: '0001', stageName: 'implementing' })).resolves.toBeUndefined();

            expect(boardRepo.write).toHaveBeenCalledTimes(1);
            expect(events.append.mock.calls.map(c => c[0].type)).toContain('stage.poisoned');
        });

        it('rethrows a transient failure so the queue retries it', async () => {
            dispatcher.run = vi.fn(async () => {
                throw new Error('socket hang up');
            });

            await expect(job.run({ cardId: '0001', stageName: 'implementing' })).rejects.toThrow('socket hang up');
            expect(boardRepo.write).not.toHaveBeenCalled();
        });

        it('does not enqueue anything after poisoning', async () => {
            dispatcher.run = vi.fn(async () => {
                throw new Error('Not logged in · Please run /login');
            });

            await job.run({ cardId: '0001', stageName: 'implementing' });
            expect(broker.send).not.toHaveBeenCalled();
        });
    });
});
