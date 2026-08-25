import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@maroonedsoftware/logger';
import { JobRunner } from '@maroonedsoftware/jobbroker';
import type { Container } from 'injectkit';
import { CARD_STAGE_DEAD_POLICY, CARD_STAGE_POLICY, JobsModule } from '#modules/jobs/jobs.module.js';
import { CARD_STAGE_CONCURRENCY } from '#modules/jobs/job.runner.config.js';

/**
 * Card 0044: `retryLimit` moved from 2 to 3. pg-boss's own expiry sweep and its shutdown-while-active
 * redelivery both consume the same `retry_count < retry_limit` budget as an ordinary thrown failure
 * (see the comment on `CARD_STAGE_POLICY`), so one slot has to exist as headroom for that before a
 * stage's own logic gets to run again — on top of, not instead of, the retries a genuine transient
 * failure gets.
 */
describe('CARD_STAGE_POLICY', () => {
    it('allows 3 retries, one more than a transient-failure budget alone, as headroom for an expiry or shutdown-while-active redelivery', () => {
        expect(CARD_STAGE_POLICY.retryLimit).toBe(3);
    });

    it('names card.stage.dead as the queue a card.stage job that exhausts this policy lands in', () => {
        expect(CARD_STAGE_POLICY.deadLetter).toBe('card.stage.dead');
    });
});

/**
 * Card 0051: `card.stage.dead` finally has a subscriber (`CardStageDeadJob`), and that handler must
 * not be able to dead-letter itself — a failure inside it should log and stop, not spend a retry
 * budget or recurse into a second, equally-unread dead-letter queue.
 */
describe('CARD_STAGE_DEAD_POLICY', () => {
    it('retries a failing card.stage.dead job zero times', () => {
        expect(CARD_STAGE_DEAD_POLICY.retryLimit).toBe(0);
    });

    it('gives card.stage.dead no dead letter of its own', () => {
        expect(CARD_STAGE_DEAD_POLICY.deadLetter).toBeUndefined();
    });
});

/**
 * Card 0063: `CARD_STAGE_CONCURRENCY` names pg-boss's own unconfigured default (jobbroker gives
 * `JobsModule` no hook to raise or lower it) rather than leaving it an unwritten fact about the
 * host. `JobsModule.start` logs it before starting the runner so the ceiling on simultaneously
 * running `card.stage` jobs is visible without reading either library's source.
 */
describe('CARD_STAGE_CONCURRENCY', () => {
    // One at a time, confirmed by observation: two cards enqueued a second apart, and the second
    // stayed in `created` until the first finished. An earlier reading of this as 2 came from a
    // sweep that caught two daemons running concurrently, not one daemon carrying two jobs.
    it('is 1, the number of stages this runner actually runs at once', () => {
        expect(CARD_STAGE_CONCURRENCY).toBe(1);
    });
});

describe('JobsModule.start', () => {
    const fakeContainer = (logger: unknown, jobRunner: unknown): Container =>
        ({
            get: (token: unknown) => {
                if (token === Logger) return logger;
                if (token === JobRunner) return jobRunner;
                throw new Error(`fakeContainer: no registration for ${String(token)}`);
            },
        }) as unknown as Container;

    it('logs the configured card.stage concurrency, naming it as a pg-boss default jobbroker cannot override', async () => {
        const info = vi.fn();
        const logger = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        const jobRunner = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };

        await JobsModule.start!(fakeContainer(logger, jobRunner), new AbortController().signal);

        expect(info).toHaveBeenCalledWith(`card.stage concurrency: ${CARD_STAGE_CONCURRENCY} (pg-boss default; jobbroker has no hook to configure it)`);
    });

    it('logs the concurrency before starting the runner, not after', async () => {
        const order: string[] = [];
        const logger = { info: () => order.push('logged'), warn: () => {}, error: () => {}, debug: () => {} };
        const jobRunner = {
            start: async () => {
                order.push('started');
            },
            stop: async () => {},
        };

        await JobsModule.start!(fakeContainer(logger, jobRunner), new AbortController().signal);

        expect(order).toEqual(['logged', 'started']);
    });

    it('still starts the runner even though logging happens first', async () => {
        const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
        const start = vi.fn(async () => {});
        const jobRunner = { start, stop: vi.fn(async () => {}) };

        await JobsModule.start!(fakeContainer(logger, jobRunner), new AbortController().signal);

        expect(start).toHaveBeenCalledTimes(1);
    });
});
