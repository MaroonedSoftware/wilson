import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { JobContext } from '@maroonedsoftware/jobbroker';
import type { PgBoss } from 'pg-boss';
import { CardStageDeadJob } from '#modules/jobs/card.stage.dead.job.js';
import { ProjectScopedBoardConfig, StaticBoardConfig } from '#modules/board/board.config.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import type { Card, CardFrontmatter } from '#modules/board/card.js';

const card = (stage: string): Card => ({
    frontmatter: {
        id: '0001',
        title: 'Card 0001',
        stage,
        dependsOn: [],
        retries: {},
    } as CardFrontmatter,
    sections: {},
    body: '',
});

describe('CardStageDeadJob', () => {
    let board: BoardConfig;
    let boardRepo: { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let cardJobs: { clear: ReturnType<typeof vi.fn> };
    let pgboss: { getJobById: ReturnType<typeof vi.fn> };
    let context: JobContext;
    let job: CardStageDeadJob;

    beforeEach(() => {
        board = new StaticBoardConfig('test', '/tmp/code', '/tmp/worktrees', '/tmp/run');
        boardRepo = { read: vi.fn(async () => card('implementing')), write: vi.fn(async () => 'sha') };
        events = { append: vi.fn(async () => {}) };
        cardJobs = { clear: vi.fn(async () => {}) };
        pgboss = { getJobById: vi.fn(async () => ({ output: { name: 'Error', message: 'exhausted retries', stack: 'stack' } })) };
        context = { id: 'dead-job-1', name: 'card.stage.dead', signal: new AbortController().signal };

        job = new CardStageDeadJob(
            pgboss as unknown as PgBoss,
            context,
            board,
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
        );
    });

    describe('card still sitting in the stage the dead job names', () => {
        beforeEach(() => {
            boardRepo.read.mockResolvedValue(card('implementing'));
        });

        it('poisons the card: transitions the board to poisoned', async () => {
            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(boardRepo.write).toHaveBeenCalledTimes(1);
            const mutate = boardRepo.write.mock.calls[0][2];
            const written = await mutate(card('implementing'));
            expect(written.frontmatter.stage).toBe('poisoned');
        });

        it('records stage.dead with the reason and job id, plus stage.poisoned and transition.written', async () => {
            await job.run({ cardId: '0001', stageName: 'implementing' });

            const types = events.append.mock.calls.map(c => c[0].type);
            expect(types).toEqual(['stage.dead', 'stage.poisoned', 'transition.written']);

            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    project: 'test',
                    cardId: '0001',
                    stage: 'implementing',
                    type: 'stage.dead',
                    payload: { jobId: 'dead-job-1', reason: 'exhausted retries' },
                }),
            );
            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'transition.written',
                    payload: expect.objectContaining({ from: 'implementing', to: 'poisoned' }),
                }),
            );
        });

        it('looks the failed output up by the currently running job id, not the original job', async () => {
            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(pgboss.getJobById).toHaveBeenCalledWith('card.stage.dead', 'dead-job-1');
        });

        it('falls back to a generic reason when the dead-letter row carries no output', async () => {
            pgboss.getJobById.mockResolvedValue(undefined);

            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'stage.dead',
                    payload: { jobId: 'dead-job-1', reason: 'card.stage exhausted its retries with no recorded error' },
                }),
            );
        });

        it('releases the claim, so the card is not left in flight after being poisoned', async () => {
            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(cardJobs.clear).toHaveBeenCalledWith('0001');
        });

        /**
         * Card 0102. This job can itself be running past `runner.stop()`, the same way `CardStageJob`
         * can, so `getJobById` can throw on a connection pg-boss already closed. That loses the
         * failure reason, not the chain: the card still gets poisoned, but with a reason that says
         * the output could not be read rather than one that reads like the dispatcher's own failure.
         */
        describe('getJobById fails to read the dead-letter output (card 0102)', () => {
            beforeEach(() => {
                pgboss.getJobById.mockRejectedValue(new Error('Database connection is not opened'));
            });

            it('does not throw, so the dead-letter job still completes', async () => {
                await expect(job.run({ cardId: '0001', stageName: 'implementing' })).resolves.toBeUndefined();
            });

            it('still appends stage.dead, with a reason that says the output could not be read', async () => {
                await job.run({ cardId: '0001', stageName: 'implementing' });

                expect(events.append).toHaveBeenCalledWith(
                    expect.objectContaining({
                        type: 'stage.dead',
                        payload: {
                            jobId: 'dead-job-1',
                            reason: 'could not read the dead-letter output: Database connection is not opened',
                        },
                    }),
                );
            });

            it('still poisons the card, with the same could-not-read reason rather than a fabricated one', async () => {
                await job.run({ cardId: '0001', stageName: 'implementing' });

                expect(boardRepo.write).toHaveBeenCalledTimes(1);
                const mutate = boardRepo.write.mock.calls[0][2];
                const written = await mutate(card('implementing'));
                expect(written.frontmatter.stage).toBe('poisoned');
                expect(events.append.mock.calls.map(c => c[0].type)).toContain('stage.poisoned');
            });

            it('still releases the claim', async () => {
                await job.run({ cardId: '0001', stageName: 'implementing' });

                expect(cardJobs.clear).toHaveBeenCalledWith('0001');
            });
        });
    });

    describe('card that already moved on before the dead row was read', () => {
        it('does not touch the board when the card progressed to a later, non-terminal stage', async () => {
            boardRepo.read.mockResolvedValue(card('testing'));

            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(boardRepo.write).not.toHaveBeenCalled();
        });

        it('does not touch the board when the card already reached a terminal state', async () => {
            boardRepo.read.mockResolvedValue(card('merged'));

            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(boardRepo.write).not.toHaveBeenCalled();
        });

        it('records only a stage.dead event flagged already-resolved, naming the card current stage', async () => {
            boardRepo.read.mockResolvedValue(card('merged'));

            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(events.append).toHaveBeenCalledTimes(1);
            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    project: 'test',
                    cardId: '0001',
                    stage: 'implementing',
                    type: 'stage.dead',
                    payload: { jobId: 'dead-job-1', alreadyResolved: true, currentStage: 'merged' },
                }),
            );
        });

        it('does not call the pg-boss job lookup, since no failure output is needed', async () => {
            boardRepo.read.mockResolvedValue(card('dropped'));

            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(pgboss.getJobById).not.toHaveBeenCalled();
        });

        it('does not release a claim that was never re-recorded for a card already off this stage', async () => {
            boardRepo.read.mockResolvedValue(card('poisoned'));

            await job.run({ cardId: '0001', stageName: 'implementing' });

            expect(cardJobs.clear).not.toHaveBeenCalled();
        });
    });
});

/**
 * Card 0050: `CardStageDeadJob` shares `poisonCard` with `CardStageJob.poison` — the notify
 * behaviour of `poisonCard` itself is covered directly in `poison.card.notify.test.ts`. This checks
 * only the wiring: that this job passes its own `board` through, so a poisoning it discovers (a
 * `card.stage` job dead-lettered after exhausting pg-boss's retries) is one of the runner's three
 * notified moments the same as any other poisoning, not a silent exception to it.
 */
describe('CardStageDeadJob notifies on poisoning (card 0050)', () => {
    let board: BoardConfig;
    let boardRepo: { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let cardJobs: { clear: ReturnType<typeof vi.fn> };
    let pgboss: { getJobById: ReturnType<typeof vi.fn> };
    let context: JobContext;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        boardRepo = { read: vi.fn(async () => card('implementing')), write: vi.fn(async () => 'sha') };
        events = { append: vi.fn(async () => {}) };
        cardJobs = { clear: vi.fn(async () => {}) };
        pgboss = { getJobById: vi.fn(async () => ({ output: { name: 'Error', message: 'exhausted retries', stack: 'stack' } })) };
        context = { id: 'dead-job-1', name: 'card.stage.dead', signal: new AbortController().signal };
        fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('posts a "poisoned" notification when a webhook is configured', async () => {
        board = new StaticBoardConfig('test', '/tmp/code', '/tmp/worktrees', '/tmp/run', 'https://hooks.example/notify');
        const job = new CardStageDeadJob(
            pgboss as unknown as PgBoss,
            context,
            board,
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
        );

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toMatchObject({ moment: 'poisoned', cardId: '0001', stage: 'implementing', reason: 'exhausted retries' });
    });

    it('makes no HTTP call when no webhook is configured', async () => {
        board = new StaticBoardConfig('test', '/tmp/code', '/tmp/worktrees', '/tmp/run');
        const job = new CardStageDeadJob(
            pgboss as unknown as PgBoss,
            context,
            board,
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
        );

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not notify when the row was already resolved, since nothing is poisoned', async () => {
        board = new StaticBoardConfig('test', '/tmp/code', '/tmp/worktrees', '/tmp/run', 'https://hooks.example/notify');
        boardRepo.read.mockResolvedValue(card('merged'));
        const job = new CardStageDeadJob(
            pgboss as unknown as PgBoss,
            context,
            board,
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
        );

        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(fetchMock).not.toHaveBeenCalled();
    });
});

/**
 * Card 0149. `CardStageDeadJob.run` resolves its project the same way `CardStageJob.run` does — see
 * `CardStagePayload.project`'s own doc comment — wrapping the whole dead-letter handling in
 * `runAsProject`. `StaticBoardConfig`, used everywhere above, cannot tell "resolved correctly" apart
 * from "never resolved at all" because its `project` field never changes; these use the real
 * `ProjectScopedBoardConfig`, with two projects registered, so a wrong resolution is observable in
 * the `stage.dead`/`stage.poisoned` events this job records.
 */
describe('CardStageDeadJob resolves its project from the payload (card 0149)', () => {
    let boardRepo: { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let cardJobs: { clear: ReturnType<typeof vi.fn> };
    let pgboss: { getJobById: ReturnType<typeof vi.fn> };
    let context: JobContext;
    let board: ProjectScopedBoardConfig;
    let job: CardStageDeadJob;

    beforeEach(() => {
        boardRepo = { read: vi.fn(async () => card('implementing')), write: vi.fn(async () => 'sha') };
        events = { append: vi.fn(async () => {}) };
        cardJobs = { clear: vi.fn(async () => {}) };
        pgboss = { getJobById: vi.fn(async () => ({ output: { name: 'Error', message: 'exhausted retries', stack: 'stack' } })) };
        context = { id: 'dead-job-1', name: 'card.stage.dead', signal: new AbortController().signal };

        board = new ProjectScopedBoardConfig('alpha');
        board.register({ name: 'alpha', codeRoot: '/tmp/alpha/code', worktreeRoot: '/tmp/alpha/wt', runRoot: '/tmp/alpha/run' });
        board.register({ name: 'beta', codeRoot: '/tmp/beta/code', worktreeRoot: '/tmp/beta/wt', runRoot: '/tmp/beta/run' });

        job = new CardStageDeadJob(
            pgboss as unknown as PgBoss,
            context,
            board,
            boardRepo as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
        );
    });

    it("falls back to the daemon's own configured project when the payload carries no project", async () => {
        await job.run({ cardId: '0001', stageName: 'implementing' });

        expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ project: 'alpha', type: 'stage.dead' }));
    });

    it("uses the project named in the payload instead of the daemon's configured default", async () => {
        await job.run({ cardId: '0001', stageName: 'implementing', project: 'beta' });

        expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ project: 'beta', type: 'stage.dead' }));
        expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ project: 'beta', type: 'stage.poisoned' }));
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ project: 'alpha' }));
    });

    it('throws rather than completing normally, when the payload names a project this daemon never registered', async () => {
        // `poisonCard` writes the board and appends `transition.written` before it ever reads
        // `board.notifyWebhookUrl` (the field that throws for an unregistered project) — this pins
        // down that the throw still happens, not that nothing at all ran beforehand.
        await expect(job.run({ cardId: '0001', stageName: 'implementing', project: 'ghost' })).rejects.toThrow(/ghost/i);

        // The claim is never released for a run that failed outright — a redelivery gets a real
        // chance to run again, rather than a card silently left both poisoned and still claimed.
        expect(cardJobs.clear).not.toHaveBeenCalled();
    });
});
