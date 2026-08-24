import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { CardStageJob } from '#modules/jobs/card.stage.job.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { NotDispatchableError } from '#modules/stages/stage.dispatcher.js';
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
    let cardJobs: { record: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; inFlight: ReturnType<typeof vi.fn> };
    let job: CardStageJob;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-'));
        const boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'config'), { recursive: true });
        await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml, 'utf8');

        board = new StaticBoardConfig('test', boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        dispatcher = { run: vi.fn(async () => outcome()) };
        broker = { send: vi.fn(async () => 'job-1') };
        events = { append: vi.fn(async () => {}) };
        boardRepo = { write: vi.fn(async () => 'sha') };
        // Card 0030: the job now hands its claim to the next job in a chain, and releases it when the
        // chain stops, so a card is never briefly un-carried in a way a poller could enqueue into.
        cardJobs = { record: vi.fn(async () => {}), clear: vi.fn(async () => {}), inFlight: vi.fn(async () => undefined) };

        job = new CardStageJob(
            dispatcher as unknown as StageDispatcher,
            broker as unknown as JobBroker,
            board,
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
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

    /**
     * Card 0030. A chaining card is continuously in flight: the claim passes from this job to the
     * next one, never lapsing in between. A clear-then-record would leave a gap, and a poller ticking
     * inside it would enqueue a second job for a card already being carried.
     */
    it('hands its claim to the next job when the chain continues, without releasing it first', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'testing' }));

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(cardJobs.record).toHaveBeenCalledWith('0001', 'job-1');
        expect(cardJobs.clear).not.toHaveBeenCalled();
    });

    it('releases the claim when the chain stops, so the card is enqueueable again', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'merged' }));

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(cardJobs.clear).toHaveBeenCalledWith('0001');
        expect(cardJobs.record).not.toHaveBeenCalled();
    });

    it('releases the claim at a manual gate, where the card waits on a human rather than a worker', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: undefined }));

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(cardJobs.clear).toHaveBeenCalledWith('0001');
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

        it('releases the claim, so a poisoned card is not left claiming a job that will never run', async () => {
            dispatcher.run = vi.fn(async () => {
                throw new Error('Not logged in · Please run /login');
            });

            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(cardJobs.clear).toHaveBeenCalledWith('0001');
        });
    });

    /**
     * Card 0044. `assertDispatchable`'s three refusals are now typed `NotDispatchableError`s instead
     * of bare `Error`s, and job 905c29e8 on card 0035 is the reason: two of these three used to fall
     * through to `isPermanentFailure`'s message matching, get retried under the queue's normal policy
     * (cutting a worktree and calling a model that would refuse identically every time), and burn the
     * budget a real, transient failure later needed. These pin the routing down by discriminant kind
     * rather than message text, so a future refusal added to `assertDispatchable` without updating
     * the routing fails loudly here instead of quietly falling back to message matching.
     */
    describe('NotDispatchableError routing', () => {
        const notDispatchable = (kind: 'wrong-stage' | 'empty-scope', message: string) =>
            new NotDispatchableError({ kind }, message);

        it.each([
            ['wrong-stage' as const, 'card 0001 is in stage "implementing", not "testing"'],
            ['empty-scope' as const, 'card 0001 has an empty "Files in scope"; nothing would be writable'],
        ])('poisons the card for a "%s" refusal, the same as a permanent failure', async (kind, message) => {
            dispatcher.run = vi.fn(async () => {
                throw notDispatchable(kind, message);
            });

            await expect(job.run({ cardId: '0001', stageName: 'implementing' })).resolves.toBeUndefined();

            expect(boardRepo.write).toHaveBeenCalledTimes(1);
            expect(events.append.mock.calls.map(c => c[0].type)).toContain('stage.poisoned');
            expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('dispatch.deferred');
            expect(cardJobs.clear).toHaveBeenCalledWith('0001');
            expect(broker.send).not.toHaveBeenCalled();
        });

        it('does not throw for a wrong-stage or empty-scope refusal, so the queue does not retry it', async () => {
            dispatcher.run = vi.fn(async () => {
                throw notDispatchable('wrong-stage', 'card 0001 is in stage "implementing", not "testing"');
            });

            await expect(job.run({ cardId: '0001', stageName: 'implementing' })).resolves.toBeUndefined();
        });

        it('defers rather than poisons an unsatisfied-dependency refusal, naming the outstanding cards', async () => {
            dispatcher.run = vi.fn(async () => {
                throw new NotDispatchableError({ kind: 'unsatisfied-dependency', outstanding: ['0030', '0031'] }, 'card 0001 is waiting on 0030, 0031');
            });

            await expect(job.run({ cardId: '0001', stageName: 'implementing' })).resolves.toBeUndefined();

            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    cardId: '0001',
                    stage: 'implementing',
                    type: 'dispatch.deferred',
                    payload: { outstanding: ['0030', '0031'], reason: 'card 0001 is waiting on 0030, 0031' },
                }),
            );
        });

        it('does not poison, write the board, or enqueue anything for an unsatisfied-dependency refusal', async () => {
            dispatcher.run = vi.fn(async () => {
                throw new NotDispatchableError({ kind: 'unsatisfied-dependency', outstanding: ['0030'] }, 'card 0001 is waiting on 0030');
            });

            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(boardRepo.write).not.toHaveBeenCalled();
            expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('stage.poisoned');
            expect(broker.send).not.toHaveBeenCalled();
        });

        it('releases the claim after deferring, so a poller can enqueue the card again later', async () => {
            dispatcher.run = vi.fn(async () => {
                throw new NotDispatchableError({ kind: 'unsatisfied-dependency', outstanding: ['0030'] }, 'card 0001 is waiting on 0030');
            });

            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(cardJobs.clear).toHaveBeenCalledWith('0001');
            expect(cardJobs.record).not.toHaveBeenCalled();
        });
    });
});
