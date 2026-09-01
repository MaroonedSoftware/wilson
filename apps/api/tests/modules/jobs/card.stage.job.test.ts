import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { CardStageJob } from '#modules/jobs/card.stage.job.js';
import { ProjectScopedBoardConfig, StaticBoardConfig } from '#modules/board/board.config.js';
import { StageConfigError } from '#modules/stages/stage.config.js';
import { PostgresStageConfigStore, StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { seedStageConfig, testDb, uniqueProject } from '#tests/support/test.db.js';
import { NotDispatchableError } from '#modules/stages/stage.dispatcher.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import type { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import type { StageOutcome } from '#modules/stages/stage.result.js';
import type { DB } from '#modules/data/db.js';
import type { Kysely } from 'kysely';

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

describe('CardStageJob', () => {
    let board: BoardConfig;
    let dispatcher: { run: ReturnType<typeof vi.fn> };
    let broker: { send: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let boardRepo: { write: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };
    let cardJobs: { record: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; inFlight: ReturnType<typeof vi.fn> };
    let job: CardStageJob;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-'));

        board = new StaticBoardConfig('test', join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        dispatcher = { run: vi.fn(async () => outcome()) };
        broker = { send: vi.fn(async () => 'job-1') };
        events = { append: vi.fn(async () => {}) };
        // Card 0104: `deferOnScopeConflict` reads the card before it does anything else. A rejected
        // read is treated the same as "nothing to defer" (see the method's own doc comment), so a
        // test double that never cares about scope conflicts can leave this unstubbed further and
        // the new check falls straight through to the behaviour these tests were written against.
        boardRepo = { write: vi.fn(async () => 'sha'), read: vi.fn(async () => { throw new Error('not stubbed'); }) };
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
            stageConfigs,
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

        // Card 0149: every enqueue now names the project it dispatches against — 'test', the
        // `StaticBoardConfig` this suite builds with, since the payload above carries no `project`
        // and `CardStageJob.run` falls back to `this.board.project` in that case.
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'testing', project: 'test' });
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

    /**
     * Card 0102. A handler can still be running after `runner.stop()` has already returned, and
     * `broker.send` throws against pg-boss's now-closed connection on the exact path every
     * multi-stage card takes on every transition. The stage above already passed and its transition
     * is already written by this point, so the job must not be retried and the card must not be
     * touched — only the failed handoff gets recorded, in a state the poller (or a human) can see
     * and recover from.
     */
    describe('the next job cannot be enqueued (card 0102)', () => {
        it('does not throw when broker.send fails to hand off the chain, so the queue does not retry it', async () => {
            dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'testing' }));
            broker.send.mockRejectedValue(new Error('Database connection is not opened'));

            await expect(job.run({ cardId: '0001', stageName: 'implementing' })).resolves.toBeUndefined();
        });

        it('records a chain.orphaned event naming the stage the card landed on and why the handoff failed', async () => {
            dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'testing' }));
            broker.send.mockRejectedValue(new Error('Database connection is not opened'));

            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    project: 'test',
                    cardId: '0001',
                    stage: 'implementing',
                    type: 'chain.orphaned',
                    payload: { target: 'testing', reason: 'Database connection is not opened' },
                }),
            );
        });

        it('does not record a claim for a job that was never enqueued', async () => {
            dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'testing' }));
            broker.send.mockRejectedValue(new Error('Database connection is not opened'));

            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(cardJobs.record).not.toHaveBeenCalled();
        });

        it('does not poison the card or write the board when the handoff fails', async () => {
            dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'testing' }));
            broker.send.mockRejectedValue(new Error('Database connection is not opened'));

            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(boardRepo.write).not.toHaveBeenCalled();
            expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('stage.poisoned');
        });
    });

    it('re-enqueues on a kickback to an earlier agent stage rather than treating it as terminal', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'implementing' }));

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'implementing', project: 'test' });
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

    /**
     * Card 0055: a flagged card stays in the stage it failed in rather than moving to a
     * `needs-human` lane, so `outcome.transitionedTo` names a perfectly ordinary, configured agent
     * stage even when the card must not be re-enqueued. `needsHuman` is the only thing standing
     * between that and dispatching the same failing stage forever.
     */
    it('stops the chain, rather than enqueuing the next job, when the outcome carries needsHuman', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'testing', needsHuman: true }));

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(broker.send).not.toHaveBeenCalled();
        expect(cardJobs.record).not.toHaveBeenCalled();
        expect(cardJobs.clear).toHaveBeenCalledWith('0001');
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'implementing',
                type: 'chain.stopped',
                payload: { target: 'testing', reason: expect.stringContaining('human') },
            }),
        );
    });

    it('enqueues normally when the outcome does not carry needsHuman, landing on the same target stage', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'testing', needsHuman: false }));

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'testing', project: 'test' });
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

        /**
         * Card 0109. `assertDispatchable`'s `needs-human` check exists for the race between a job
         * being enqueued and dispatched: whatever flagged the card already wrote the reason and
         * already notified before this job ever reached `dispatcher.run`. Left unrouted, this fell
         * into the same default branch as `wrong-stage`/`empty-scope` and poisoned an already-flagged
         * card — strictly worse than the refusal it was meant to produce.
         */
        it('defers rather than poisons a needs-human refusal', async () => {
            dispatcher.run = vi.fn(async () => {
                throw new NotDispatchableError({ kind: 'needs-human' }, 'card 0001 is flagged for a human and will not dispatch until it is cleared');
            });

            await expect(job.run({ cardId: '0001', stageName: 'implementing' })).resolves.toBeUndefined();

            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    cardId: '0001',
                    stage: 'implementing',
                    type: 'dispatch.deferred',
                    payload: { reason: 'card 0001 is flagged for a human and will not dispatch until it is cleared' },
                }),
            );
        });

        it('does not poison, write the board, or enqueue anything for a needs-human refusal', async () => {
            dispatcher.run = vi.fn(async () => {
                throw new NotDispatchableError({ kind: 'needs-human' }, 'card 0001 is flagged for a human and will not dispatch until it is cleared');
            });

            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(boardRepo.write).not.toHaveBeenCalled();
            expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('stage.poisoned');
            expect(broker.send).not.toHaveBeenCalled();
            expect(cardJobs.clear).toHaveBeenCalledWith('0001');
            expect(cardJobs.record).not.toHaveBeenCalled();
        });
    });

    /**
     * Card 0031. `StageDispatcher.run` calls `stageConfigs.load()` and `findStage` before `assertDispatchable`
     * ever gets a chance to throw a typed `NotDispatchableError`, so a `StageConfigError` used to fall
     * through to `isPermanentFailure`'s message matching, match no pattern, and retry twice under
     * `CARD_STAGE_POLICY` before dead-lettering silently — no `stage.poisoned` event, no transition,
     * no operator-visible signal at all. These exercise `CardStageJob` end to end the same way the
     * `NotDispatchableError routing` block above does, with `dispatcher.run` throwing the typed error
     * `StageDispatcher` now actually throws.
     */
    describe('StageConfigError routing (card 0031)', () => {
        it('poisons a stage-not-found error, naming the missing stage, and does not retry', async () => {
            dispatcher.run = vi.fn(async () => {
                throw new StageConfigError('stage-not-found', 'no stage named "needs-human" in stages.yaml (have: implementing, testing, review)');
            });

            await expect(job.run({ cardId: '0001', stageName: 'needs-human' })).resolves.toBeUndefined();

            expect(boardRepo.write).toHaveBeenCalledTimes(1);
            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    cardId: '0001',
                    stage: 'needs-human',
                    type: 'stage.poisoned',
                    payload: expect.objectContaining({ reason: expect.stringContaining('needs-human') }),
                }),
            );
            expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('dispatch.deferred');
            expect(broker.send).not.toHaveBeenCalled();
            expect(cardJobs.clear).toHaveBeenCalledWith('0001');
        });

        it('defers rather than poisons a config-invalid error, naming the broken config, and leaves the card untouched', async () => {
            dispatcher.run = vi.fn(async () => {
                throw new StageConfigError('config-invalid', 'could not read stages.yaml: ENOENT: no such file or directory');
            });

            await expect(job.run({ cardId: '0001', stageName: 'implementing' })).resolves.toBeUndefined();

            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    cardId: '0001',
                    stage: 'implementing',
                    type: 'dispatch.deferred',
                    payload: { reason: 'could not read stages.yaml: ENOENT: no such file or directory' },
                }),
            );
            expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('stage.poisoned');
            expect(boardRepo.write).not.toHaveBeenCalled();
            expect(broker.send).not.toHaveBeenCalled();
            expect(cardJobs.clear).toHaveBeenCalledWith('0001');
            expect(cardJobs.record).not.toHaveBeenCalled();
        });

        it('does not throw for either StageConfigError kind, so the queue never retries a card in the wrong stage or a broken config', async () => {
            dispatcher.run = vi.fn(async () => {
                throw new StageConfigError('stage-not-found', 'no stage named "gone" in stages.yaml (have: implementing)');
            });
            await expect(job.run({ cardId: '0001', stageName: 'gone' })).resolves.toBeUndefined();

            dispatcher.run = vi.fn(async () => {
                throw new StageConfigError('config-invalid', 'stages.yaml is not valid stage config: stages.0.mode: Required');
            });
            await expect(job.run({ cardId: '0002', stageName: 'implementing' })).resolves.toBeUndefined();
        });

        /**
         * The acceptance criterion that motivates `defer` over `poison` here: one bad `stages.yaml`
         * must not turn into a board full of poisoned cards a human then has to walk back one at a
         * time. Two different cards hitting the same broken config both defer, and neither is touched.
         */
        it('defers every card that hits the same broken stages.yaml, poisoning none of them', async () => {
            dispatcher.run = vi.fn(async () => {
                throw new StageConfigError('config-invalid', 'stages.yaml is not valid stage config: stages.0.model: Required');
            });

            await job.run({ cardId: '0001', stageName: 'implementing' });
            await job.run({ cardId: '0002', stageName: 'implementing' });

            const deferredCardIds = events.append.mock.calls.filter(c => c[0].type === 'dispatch.deferred').map(c => c[0].cardId);
            expect(deferredCardIds).toEqual(['0001', '0002']);
            expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('stage.poisoned');
            expect(boardRepo.write).not.toHaveBeenCalled();
        });
    });

    /**
     * Card 0084. Card 0066 was merged by a human while its `review` job was still queued; the job
     * dispatched five seconds later, `assertDispatchable` threw `wrong-stage`, and card 0044's
     * handler poisoned an already-finished card. It happened again on card 0082. The fix: a
     * `wrong-stage` refusal whose `actualStage` is terminal is a stale job, not a bug, and must
     * change nothing about the card.
     */
    describe('stale dispatch for a card that already finished (card 0084)', () => {
        const wrongStage = (actualStage: string, message: string) => new NotDispatchableError({ kind: 'wrong-stage', actualStage }, message);

        it.each([['merged'], ['dropped'], ['poisoned']])(
            'records stage.stale, does not poison, and does not transition when the card is already "%s"',
            async actualStage => {
                dispatcher.run = vi.fn(async () => {
                    throw wrongStage(actualStage, `card 0001 is in stage "${actualStage}", not "review"`);
                });

                await expect(job.run({ cardId: '0001', stageName: 'review' })).resolves.toBeUndefined();

                expect(events.append).toHaveBeenCalledWith(
                    expect.objectContaining({
                        project: 'test',
                        cardId: '0001',
                        stage: 'review',
                        type: 'stage.stale',
                        payload: { wantedStage: 'review', actualStage },
                    }),
                );
                expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('stage.poisoned');
                expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('transition.written');
                expect(boardRepo.write).not.toHaveBeenCalled();
            },
        );

        it('does not enqueue anything for a stale dispatch', async () => {
            dispatcher.run = vi.fn(async () => {
                throw wrongStage('merged', 'card 0001 is in stage "merged", not "review"');
            });

            await job.run({ cardId: '0001', stageName: 'review' });

            expect(broker.send).not.toHaveBeenCalled();
        });

        it('releases the claim on a stale dispatch, so the card is not left claiming a job that will never run', async () => {
            dispatcher.run = vi.fn(async () => {
                throw wrongStage('merged', 'card 0001 is in stage "merged", not "review"');
            });

            await job.run({ cardId: '0001', stageName: 'review' });

            expect(cardJobs.clear).toHaveBeenCalledWith('0001');
        });

        it('does not throw for a stale dispatch, so the queue does not retry it', async () => {
            dispatcher.run = vi.fn(async () => {
                throw wrongStage('merged', 'card 0001 is in stage "merged", not "review"');
            });

            await expect(job.run({ cardId: '0001', stageName: 'review' })).resolves.toBeUndefined();
        });

        // A card genuinely in the wrong (non-terminal) stage is card 0044's bug, untouched by this
        // card — it must still poison exactly as before, even though the refusal now carries
        // `actualStage`.
        it('still poisons a "wrong-stage" refusal whose actual stage is an ordinary, non-terminal stage', async () => {
            dispatcher.run = vi.fn(async () => {
                throw wrongStage('implementing', 'card 0001 is in stage "implementing", not "testing"');
            });

            await expect(job.run({ cardId: '0001', stageName: 'testing' })).resolves.toBeUndefined();

            expect(boardRepo.write).toHaveBeenCalledTimes(1);
            expect(events.append.mock.calls.map(c => c[0].type)).toContain('stage.poisoned');
            expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('stage.stale');
            expect(cardJobs.clear).toHaveBeenCalledWith('0001');
        });

        // `isTerminal` deliberately excludes `parking-lot`: a parked card is waiting to be promoted,
        // not finished, so a stale-looking job that lands on one is still card 0044's bug.
        it('still poisons a "wrong-stage" refusal when the card is in "parking-lot", which is not terminal', async () => {
            dispatcher.run = vi.fn(async () => {
                throw wrongStage('parking-lot', 'card 0001 is in stage "parking-lot", not "testing"');
            });

            await expect(job.run({ cardId: '0001', stageName: 'testing' })).resolves.toBeUndefined();

            expect(boardRepo.write).toHaveBeenCalledTimes(1);
            expect(events.append.mock.calls.map(c => c[0].type)).toContain('stage.poisoned');
            expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('stage.stale');
        });
    });
});

/**
 * Card 0149. `CardStagePayload.project` — see its own doc comment — is what `CardStageJob.run`
 * resolves against `ProjectScopedBoardConfig`, wrapped in `runAsProject` for the whole dispatch. Every
 * test above uses `StaticBoardConfig`, which does not care what project is on the call stack (its
 * `project` field is fixed at construction), so it cannot tell "resolution happened correctly" apart
 * from "resolution never ran at all". These use the real `ProjectScopedBoardConfig` instead, with two
 * projects registered, so a wrong resolution would actually be observable — a `broker.send`/
 * `events.append` carrying the wrong project's name, or the stage config store reading the wrong
 * project's config entirely. That last one needs the real `PostgresStageConfigStore`, keyed by
 * `BoardConfig.project` — a `StaticStageConfigStore` answers the same for every project — with a row
 * seeded per project, so a project this daemon never registered has no config to find.
 */
describe('CardStageJob resolves its project from the payload (card 0149)', () => {
    let db: Kysely<DB>;
    // Unique per run, the way every suite that touches the test database names its projects (see
    // `uniqueProject`): the stage config rows seeded below would otherwise pile up under one name.
    const alpha = uniqueProject();
    const beta = uniqueProject();

    beforeAll(async () => {
        db = testDb();
        await seedStageConfig(db, alpha, stagesYaml);
        await seedStageConfig(db, beta, stagesYaml);
    });
    afterAll(async () => {
        await db.destroy();
    });

    let dispatcher: { run: ReturnType<typeof vi.fn> };
    let broker: { send: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let boardRepo: { write: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };
    let cardJobs: { record: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; inFlight: ReturnType<typeof vi.fn> };
    let board: InstanceType<typeof ProjectScopedBoardConfig>;
    let job: CardStageJob;

    beforeEach(async () => {
        const alphaBase = await mkdtemp(join(tmpdir(), 'card-stage-job-alpha-'));
        const betaBase = await mkdtemp(join(tmpdir(), 'card-stage-job-beta-'));

        board = new ProjectScopedBoardConfig(alpha);
        board.register({ name: alpha, codeRoot: join(alphaBase, 'code'), worktreeRoot: join(alphaBase, 'wt'), runRoot: join(alphaBase, 'run') });
        board.register({ name: beta, codeRoot: join(betaBase, 'code'), worktreeRoot: join(betaBase, 'wt'), runRoot: join(betaBase, 'run') });

        dispatcher = { run: vi.fn(async () => outcome({ transitionedTo: 'testing' })) };
        broker = { send: vi.fn(async () => 'job-1') };
        events = { append: vi.fn(async () => {}) };
        boardRepo = { write: vi.fn(async () => 'sha'), read: vi.fn(async () => { throw new Error('not stubbed'); }) };
        cardJobs = { record: vi.fn(async () => {}), clear: vi.fn(async () => {}), inFlight: vi.fn(async () => undefined) };

        job = new CardStageJob(
            dispatcher as unknown as StageDispatcher,
            broker as unknown as JobBroker,
            board,
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
            new PostgresStageConfigStore(board, db),
        );
    });

    it('falls back to the daemon\'s own configured project when the payload carries no project', async () => {
        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'testing', project: alpha });
    });

    it('uses the project named in the payload instead of the daemon\'s configured default', async () => {
        await job.run({ cardId: '0001', stageName: 'implementing', project: beta });

        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'testing', project: beta });
        expect(broker.send).not.toHaveBeenCalledWith('card.stage', expect.objectContaining({ project: alpha }));
    });

    it('records a chain-stop event under the payload\'s named project, not the daemon\'s default', async () => {
        dispatcher.run.mockResolvedValue(outcome({ transitionedTo: 'review' })); // review is a manual stage — chain stops here

        await job.run({ cardId: '0001', stageName: 'testing', project: beta });

        expect(broker.send).not.toHaveBeenCalled();
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({ project: beta, cardId: '0001', stage: 'testing', type: 'chain.stopped' }),
        );
    });

    it('throws rather than dispatching, when the payload names a project this daemon never registered', async () => {
        await expect(job.run({ cardId: '0001', stageName: 'implementing', project: 'ghost' })).rejects.toThrow(/ghost/i);

        // Nothing was dispatched or recorded against any project — an unregistered project must fail
        // loudly, not run silently against whichever project happened to be the default.
        expect(broker.send).not.toHaveBeenCalled();
    });
});

/**
 * Card 0050: a `manual` gate reached normally is one of the three moments notified, and it is the
 * one moment `CardStageJob` itself decides to notify on (the other two, `needsHuman` and
 * `poisoned`, are notified where they are written — `StageDispatcher` and `poisonCard`). These stub
 * `fetch` rather than the `Notifier` class, so what is asserted is the observable HTTP call a real
 * webhook would see, not that some internal method was called.
 */
describe('CardStageJob notifies a manual gate (card 0050)', () => {
    let dispatcher: { run: ReturnType<typeof vi.fn> };
    let broker: { send: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let boardRepo: { write: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };
    let cardJobs: { record: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; inFlight: ReturnType<typeof vi.fn> };
    let fetchMock: ReturnType<typeof vi.fn>;

    const buildJob = async (notifyWebhookUrl?: string, notifyBaseUrl?: string) => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-notify-'));

        const board = new StaticBoardConfig(
            'test',
            join(base, 'code'),
            join(base, 'worktrees'),
            join(base, 'run'),
            notifyWebhookUrl,
            notifyBaseUrl,
        );

        return new CardStageJob(
            dispatcher as unknown as StageDispatcher,
            broker as unknown as JobBroker,
            board,
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
            stageConfigs,
        );
    };

    beforeEach(() => {
        dispatcher = { run: vi.fn(async () => outcome({ transitionedTo: 'review' })) };
        broker = { send: vi.fn(async () => 'job-1') };
        events = { append: vi.fn(async () => {}) };
        boardRepo = {
            write: vi.fn(async () => 'sha'),
            read: vi.fn(async () => ({
                frontmatter: { id: '0001', title: 'a card waiting on review', stage: 'review', dependsOn: [], retries: {} },
                sections: {},
                body: '',
            })),
        };
        cardJobs = { record: vi.fn(async () => {}), clear: vi.fn(async () => {}), inFlight: vi.fn(async () => undefined) };
        fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('posts a "manual" notification carrying the card title, the stage landed on, and a deep link', async () => {
        const job = await buildJob('https://hooks.example/notify', 'https://board.example');

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toMatchObject({
            moment: 'manual',
            project: 'test',
            cardId: '0001',
            title: 'a card waiting on review',
            stage: 'review',
            url: 'https://board.example/cards/0001',
        });
        expect('reason' in body).toBe(false);
    });

    it('makes no HTTP call, and does not re-read the card for notification, when no webhook URL is configured', async () => {
        const job = await buildJob(undefined);

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(fetchMock).not.toHaveBeenCalled();
        // Card 0104: `deferOnScopeConflict` now reads the card once before every dispatch, regardless
        // of notification config, so "never reads the card" no longer holds — what this still pins
        // down is that `notifyManualGate` does not read it a second time when no webhook is set.
        expect(boardRepo.read).toHaveBeenCalledTimes(1);
    });

    // `decideChain` checks `needsHuman` before it ever looks at the target stage's mode, so a card
    // that lands on a manual-mode stage carrying `needsHuman` is the needsHuman moment, already
    // notified in `StageDispatcher` — not a second, manual-gate notification for the same event.
    it('does not notify here when the outcome carries needsHuman, even though it lands on a manual stage', async () => {
        dispatcher.run = vi.fn(async () => outcome({ transitionedTo: 'review', needsHuman: true }));
        const job = await buildJob('https://hooks.example/notify');

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not notify when the chain instead advances to another agent stage', async () => {
        dispatcher.run = vi.fn(async () => outcome({ transitionedTo: 'testing' }));
        const job = await buildJob('https://hooks.example/notify');

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('falls back to the card id as the title when re-reading the card fails', async () => {
        boardRepo.read = vi.fn(async () => {
            throw new Error('board unreachable');
        });
        const job = await buildJob('https://hooks.example/notify');

        await job.run({ cardId: '0001', stageName: 'testing' });

        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.title).toBe('0001');
    });

    it('does not fail the run when the webhook itself fails', async () => {
        fetchMock.mockImplementation(async () => {
            throw new Error('ECONNREFUSED');
        });
        const job = await buildJob('https://hooks.example/notify');

        await expect(job.run({ cardId: '0001', stageName: 'testing' })).resolves.toBeUndefined();
        // The chain-stop bookkeeping still happened; the notification failure did not unwind it.
        expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'chain.stopped' }));
    });
});

/**
 * Card 0104. Two cards whose plans (or `request_scope` grants) name the same file could both
 * dispatch, because nothing before this asked what else was running before cutting a worktree.
 * `deferOnScopeConflict` is the fix: it runs ahead of `this.dispatcher.run`, on the one path every
 * dispatch — poller or `wilson card start` — arrives at, so it is exercised here directly against
 * `boardRepo.scopeConflict` rather than against `StageDispatcher`, which never sees a deferred card
 * at all.
 */
describe('CardStageJob defers on a scope conflict before dispatching (card 0104)', () => {
    let board: BoardConfig;
    let dispatcher: { run: ReturnType<typeof vi.fn> };
    let broker: { send: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let boardRepo: { write: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; scopeConflict: ReturnType<typeof vi.fn> };
    let cardJobs: { record: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; inFlight: ReturnType<typeof vi.fn> };

    const dispatchingCard = {
        frontmatter: { id: '0001', title: 'a card that might collide', stage: 'implementing', dependsOn: [], retries: {} },
        sections: {},
        body: '',
    };

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-scope-conflict-'));

        board = new StaticBoardConfig('test', join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        dispatcher = { run: vi.fn(async () => outcome()) };
        broker = { send: vi.fn(async () => 'job-1') };
        events = { append: vi.fn(async () => {}) };
        boardRepo = {
            write: vi.fn(async () => 'sha'),
            read: vi.fn(async () => dispatchingCard),
            scopeConflict: vi.fn(async () => undefined),
        };
        cardJobs = { record: vi.fn(async () => {}), clear: vi.fn(async () => {}), inFlight: vi.fn(async () => undefined) };
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
        );

    it('defers, naming the other card and the overlapping paths, without ever calling the dispatcher', async () => {
        boardRepo.scopeConflict.mockResolvedValue({
            cardId: '0089',
            overlap: [{ ours: 'apps/api/src/modules/events/card.event.ts', theirs: 'apps/api/src/modules/events/card.event.ts' }],
        });
        const job = buildJob();

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(dispatcher.run).not.toHaveBeenCalled();
        expect(broker.send).not.toHaveBeenCalled();
        // Card 0104's doc comment on `deferOnScopeConflict` (predispatch/scope.conflict.ts)
        // promises "no board write, no retry charged, no flag" — this is what pins that down: a
        // scope-conflict defer never touches `boardRepo.write`, so nothing about the card's stage,
        // retries, or flags changes underneath it, the same as an unsatisfied-dependency defer.
        expect(boardRepo.write).not.toHaveBeenCalled();
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                project: 'test',
                cardId: '0001',
                stage: 'implementing',
                type: 'dispatch.deferred',
                payload: {
                    outstanding: ['0089'],
                    reason: '0001 deferred: apps/api/src/modules/events/card.event.ts is in flight on 0089',
                },
            }),
        );
    });

    it('releases the claim after deferring on a scope conflict, so a poller can enqueue the card again later', async () => {
        boardRepo.scopeConflict.mockResolvedValue({
            cardId: '0089',
            overlap: [{ ours: 'apps/api/src/modules/events/card.event.ts', theirs: 'apps/api/src/modules/events/card.event.ts' }],
        });
        const job = buildJob();

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(cardJobs.clear).toHaveBeenCalledWith('0001');
        expect(cardJobs.record).not.toHaveBeenCalled();
    });

    it('does not defer, and dispatches normally, when boardRepo.scopeConflict reports no conflict', async () => {
        const job = buildJob();

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(boardRepo.scopeConflict).toHaveBeenCalledWith(events, 'test', dispatchingCard, expect.anything());
        expect(dispatcher.run).toHaveBeenCalledWith('0001', 'implementing');
        expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('dispatch.deferred');
    });

    it('skips the check, and dispatches normally, when the card has already moved off the dispatched stage', async () => {
        boardRepo.read.mockResolvedValue({
            ...dispatchingCard,
            frontmatter: { ...dispatchingCard.frontmatter, stage: 'testing' },
        });
        const job = buildJob();

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(boardRepo.scopeConflict).not.toHaveBeenCalled();
        expect(dispatcher.run).toHaveBeenCalledWith('0001', 'implementing');
    });
});
