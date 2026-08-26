import { describe, expect, it, vi } from 'vitest';
import type { JobRunner } from '@maroonedsoftware/jobbroker';
import { Container } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';

/**
 * Card 0066. `node:timers/promises`'s `setTimeout` is mocked here so `SHUTDOWN_DEADLINE_MS`'s real
 * 35s wait never actually elapses in the suite: the test only needs to prove the deadline path
 * exists and is what `Promise.race` picks when `runner.stop()` itself never settles, not to prove
 * real wall-clock time passes. `vi.useFakeTimers()` does not intercept `node:timers/promises`
 * (verified separately) — it patches the global `setTimeout`, and the promisified version does not
 * go through it — so a module mock is the only way to control this without a real 35s test.
 */
const delayMock = vi.fn(async () => undefined);
vi.mock('node:timers/promises', () => ({ setTimeout: delayMock }));

const { AbandonedCardJobsError, JobsModule, SHUTDOWN_DEADLINE_MS, stopCardStageJobs } = await import('#modules/jobs/jobs.module.js');
const { RunningCards } = await import('#modules/jobs/running.cards.js');
const { JobRunner: JobRunnerToken } = await import('@maroonedsoftware/jobbroker');

/**
 * Card 0098: `stopCardStageJobs` confirms via `CardJobs.confirmInFlightAfterStop`, not `inFlight` —
 * the whole point being that the confirmation must still work once `runner.stop()` has closed
 * pg-boss's own connection, which is precisely the moment `inFlight`'s broker call starts throwing.
 * This fake deliberately implements only `confirmInFlightAfterStop`; a `stopCardStageJobs` that
 * regressed to calling `inFlight` again would throw here too (a bare `TypeError`, "is not a
 * function"), the same shape of failure it would hit against the real broker post-stop.
 *
 * An entry may be a job id (still in flight), `undefined` (settled), or an `Error` (the confirmation
 * itself could not be completed — see the `unconfirmed` tests below).
 */
type FakeCardJobs = { confirmInFlightAfterStop: ReturnType<typeof vi.fn> };

const fakeCardJobs = (outcomes: Record<string, string | undefined | Error>): FakeCardJobs => ({
    confirmInFlightAfterStop: vi.fn(async (cardId: string) => {
        const outcome = outcomes[cardId];
        if (outcome instanceof Error) throw outcome;
        return outcome;
    }),
});

const fakeRunner = (stop: () => Promise<void>): JobRunner => ({ start: vi.fn(), stop } as unknown as JobRunner);

describe('stopCardStageJobs', () => {
    it('reports a clean stop when the runner settles and nothing is tracked as running', async () => {
        const runner = fakeRunner(vi.fn().mockResolvedValue(undefined));
        const report = await stopCardStageJobs(runner, new RunningCards(), fakeCardJobs({}) as never);

        expect(report.abandoned).toEqual([]);
        expect(report.unconfirmed).toEqual([]);
    });

    /**
     * The exact defect this card fixes: pg-boss's own `stop()` can resolve while a handler it claims
     * to have waited for is still going. `RunningCards` still showing the card past that point, with
     * the post-stop confirmation finding the claim still live, is what makes that visible. Before
     * card 0098 this confirmation ran through `CardJobs.inFlight` — a broker call that throws once
     * `stop()` has closed pg-boss's connection — so this used to die with an uncaught rejection
     * instead of ever reaching this assertion.
     */
    it('reports a card RunningCards still shows once the runner resolves, confirmed still in flight', async () => {
        const runner = fakeRunner(vi.fn().mockResolvedValue(undefined));
        const running = new RunningCards();
        running.add('0099');

        const cardJobs = fakeCardJobs({ '0099': 'job-77' });
        const report = await stopCardStageJobs(runner, running, cardJobs as never);

        expect(report.abandoned).toEqual([{ cardId: '0099', jobId: 'job-77' }]);
        expect(report.unconfirmed).toEqual([]);
        expect(cardJobs.confirmInFlightAfterStop).toHaveBeenCalledWith('0099');
    });

    it('does not report a card RunningCards still shows if it had actually already settled by the time this checks', async () => {
        const runner = fakeRunner(vi.fn().mockResolvedValue(undefined));
        const running = new RunningCards();
        running.add('0099');

        const report = await stopCardStageJobs(runner, running, fakeCardJobs({}) as never);

        expect(report.abandoned).toEqual([]);
        expect(report.unconfirmed).toEqual([]);
    });

    it('proceeds once the shutdown deadline elapses even if runner.stop() itself never resolves', async () => {
        const neverResolves = new Promise<void>(() => {});
        const runner = fakeRunner(() => neverResolves);

        const report = await stopCardStageJobs(runner, new RunningCards(), fakeCardJobs({}) as never);

        expect(report.abandoned).toEqual([]);
        expect(delayMock).toHaveBeenCalledWith(SHUTDOWN_DEADLINE_MS);
    });

    /**
     * Card 0098, task 2. The confirmation itself can fail — the original bug's exact shape,
     * `CardJobs.inFlight`'s broker call throwing once `stop()` has closed pg-boss's connection. That
     * must neither crash `stopCardStageJobs` (an uncaught rejection killing the shutdown hook, the
     * original defect) nor be swallowed into a clean report (worse than today, since today at least
     * it is loud): it becomes a third, explicit state instead.
     */
    it('collects a card into unconfirmed, not abandoned and not a clean report, when confirmation itself throws', async () => {
        const runner = fakeRunner(vi.fn().mockResolvedValue(undefined));
        const running = new RunningCards();
        running.add('0099');

        const report = await stopCardStageJobs(
            runner,
            running,
            fakeCardJobs({ '0099': new Error('Database connection is not opened') }) as never,
        );

        expect(report.abandoned).toEqual([]);
        expect(report.unconfirmed).toEqual([{ cardId: '0099', reason: 'Database connection is not opened' }]);
    });

    it('does not let one unconfirmed card stop the rest of RunningCards from being checked', async () => {
        const runner = fakeRunner(vi.fn().mockResolvedValue(undefined));
        const running = new RunningCards();
        running.add('0098');
        running.add('0099');

        const report = await stopCardStageJobs(runner, running, fakeCardJobs({ '0098': new Error('boom'), '0099': 'job-77' }) as never);

        expect(report.unconfirmed).toEqual([{ cardId: '0098', reason: 'boom' }]);
        expect(report.abandoned).toEqual([{ cardId: '0099', jobId: 'job-77' }]);
    });

    it('stringifies a thrown non-Error value into the reason', async () => {
        const runner = fakeRunner(vi.fn().mockResolvedValue(undefined));
        const running = new RunningCards();
        running.add('0099');

        const cardJobs: FakeCardJobs = {
            confirmInFlightAfterStop: vi.fn(() => Promise.reject('not an Error instance')),
        };
        const report = await stopCardStageJobs(runner, running, cardJobs as never);

        expect(report.unconfirmed).toEqual([{ cardId: '0099', reason: 'not an Error instance' }]);
    });
});

describe('AbandonedCardJobsError', () => {
    it('names every abandoned card and its job, and says redelivery will happen', () => {
        const error = new AbandonedCardJobsError([
            { cardId: '0052', jobId: 'job-1' },
            { cardId: '0060', jobId: 'job-2' },
        ]);

        expect(error.name).toBe('AbandonedCardJobsError');
        expect(error.message).toContain('2 card.stage job(s)');
        expect(error.message).toContain('0052 (job job-1)');
        expect(error.message).toContain('0060 (job job-2)');
        expect(error.message).toContain('redelivered');
        expect(error.abandoned).toEqual([
            { cardId: '0052', jobId: 'job-1' },
            { cardId: '0060', jobId: 'job-2' },
        ]);
        expect(error.unconfirmed).toEqual([]);
    });

    /**
     * Card 0098. `unconfirmed` is a distinct, truthful third state — not folded into "abandoned"
     * (which claims the job is known still running) and not silently dropped. The message says
     * specifically that these could not be confirmed either way.
     */
    it('names every unconfirmed card and its reason, distinctly from abandoned', () => {
        const error = new AbandonedCardJobsError([], [{ cardId: '0091', reason: 'Database connection is not opened' }]);

        expect(error.message).toContain('could not confirm 1 card(s) settled or abandoned');
        expect(error.message).toContain('0091 (Database connection is not opened)');
        expect(error.message).not.toContain('card.stage job(s)');
        expect(error.abandoned).toEqual([]);
        expect(error.unconfirmed).toEqual([{ cardId: '0091', reason: 'Database connection is not opened' }]);
    });

    it('reports both abandoned and unconfirmed cards together when both are present', () => {
        const error = new AbandonedCardJobsError([{ cardId: '0052', jobId: 'job-1' }], [{ cardId: '0091', reason: 'boom' }]);

        expect(error.message).toContain('1 card.stage job(s)');
        expect(error.message).toContain('0052 (job job-1)');
        expect(error.message).toContain('could not confirm 1 card(s) settled or abandoned');
        expect(error.message).toContain('0091 (boom)');
    });
});

describe('JobsModule.shutdown', () => {
    const buildContainer = (runner: { start: () => Promise<void>; stop: () => Promise<void> }, logger: { error: ReturnType<typeof vi.fn> }) =>
        ({
            get: (token: unknown) => {
                if (token === JobRunnerToken) return runner;
                if (token === Logger) return logger;
                throw new Error(`buildContainer: unexpected token ${String(token)}`);
            },
        }) as unknown as Container;

    it('logs and swallows an AbandonedCardJobsError, so abandonment does not stop the rest of shutdown from running', async () => {
        const error = new AbandonedCardJobsError([{ cardId: '0052', jobId: 'job-9' }]);
        const runner = { start: vi.fn(), stop: vi.fn().mockRejectedValue(error) };
        const logger = { error: vi.fn() };
        const container = buildContainer(runner, logger);

        await expect(JobsModule.shutdown?.(container)).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith(error.message);
    });

    /**
     * Card 0098, task 2: an unconfirmed-only stop is still an unclean one and must still surface
     * loudly, the same as an abandoned one — "could not confirm" is not treated as "everything was
     * fine".
     */
    it('logs and swallows an AbandonedCardJobsError carrying only unconfirmed cards', async () => {
        const error = new AbandonedCardJobsError([], [{ cardId: '0091', reason: 'Database connection is not opened' }]);
        const runner = { start: vi.fn(), stop: vi.fn().mockRejectedValue(error) };
        const logger = { error: vi.fn() };
        const container = buildContainer(runner, logger);

        await expect(JobsModule.shutdown?.(container)).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith(error.message);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not confirm 1 card(s)'));
    });

    it('rethrows a stop() failure that is not an AbandonedCardJobsError', async () => {
        const boom = new Error('pool already closed');
        const runner = { start: vi.fn(), stop: vi.fn().mockRejectedValue(boom) };
        const logger = { error: vi.fn() };
        const container = buildContainer(runner, logger);

        await expect(JobsModule.shutdown?.(container)).rejects.toThrow('pool already closed');
    });
});
