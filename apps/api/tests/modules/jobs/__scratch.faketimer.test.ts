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
const { RunningCards } = await import('#modules/jobs/card.stage.job.js');
const { JobRunner: JobRunnerToken } = await import('@maroonedsoftware/jobbroker');

type FakeCardJobs = { inFlight: ReturnType<typeof vi.fn> };

const fakeCardJobs = (live: Record<string, string | undefined>): FakeCardJobs => ({
    inFlight: vi.fn(async (cardId: string) => live[cardId]),
});

const fakeRunner = (stop: () => Promise<void>): JobRunner => ({ start: vi.fn(), stop } as unknown as JobRunner);

describe('stopCardStageJobs', () => {
    it('reports a clean stop when the runner settles and nothing is tracked as running', async () => {
        const runner = fakeRunner(vi.fn().mockResolvedValue(undefined));
        const report = await stopCardStageJobs(runner, new RunningCards(), fakeCardJobs({}) as never);

        expect(report.abandoned).toEqual([]);
    });

    /**
     * The exact defect this card fixes: pg-boss's own `stop()` can resolve while a handler it claims
     * to have waited for is still going. `RunningCards` still showing the card past that point, with
     * `CardJobs.inFlight` confirming the claim is still live, is what makes that visible.
     */
    it('reports a card RunningCards still shows once the runner resolves, confirmed still in flight', async () => {
        const runner = fakeRunner(vi.fn().mockResolvedValue(undefined));
        const running = new RunningCards();
        running.add('0099');

        const report = await stopCardStageJobs(runner, running, fakeCardJobs({ '0099': 'job-77' }) as never);

        expect(report.abandoned).toEqual([{ cardId: '0099', jobId: 'job-77' }]);
    });

    it('does not report a card RunningCards still shows if it had actually already settled by the time this checks', async () => {
        const runner = fakeRunner(vi.fn().mockResolvedValue(undefined));
        const running = new RunningCards();
        running.add('0099');

        const report = await stopCardStageJobs(runner, running, fakeCardJobs({}) as never);

        expect(report.abandoned).toEqual([]);
    });

    it('proceeds once the shutdown deadline elapses even if runner.stop() itself never resolves', async () => {
        const neverResolves = new Promise<void>(() => {});
        const runner = fakeRunner(() => neverResolves);

        const report = await stopCardStageJobs(runner, new RunningCards(), fakeCardJobs({}) as never);

        expect(report.abandoned).toEqual([]);
        expect(delayMock).toHaveBeenCalledWith(SHUTDOWN_DEADLINE_MS);
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

    it('rethrows a stop() failure that is not an AbandonedCardJobsError', async () => {
        const boom = new Error('pool already closed');
        const runner = { start: vi.fn(), stop: vi.fn().mockRejectedValue(boom) };
        const logger = { error: vi.fn() };
        const container = buildContainer(runner, logger);

        await expect(JobsModule.shutdown?.(container)).rejects.toThrow('pool already closed');
    });
});
