import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@maroonedsoftware/logger';
import { JobRunner } from '@maroonedsoftware/jobbroker';
import { PgBossJobRegistryMap } from '@maroonedsoftware/jobbroker/pgboss';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import type { Container, Identifier, Registry } from 'injectkit';
import { CARD_STAGE_DEAD_POLICY, CARD_STAGE_POLICY, CARD_STAGE_WORKER, JobsModule } from '#modules/jobs/jobs.module.js';
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
 * Card 0063: `CARD_STAGE_CONCURRENCY` names the ceiling on simultaneously running `card.stage` jobs
 * rather than leaving it an unwritten fact about the host, and `JobsModule.start` logs it before
 * starting the runner so it is visible without reading the registration.
 *
 * It named pg-boss's unconfigured default while jobbroker had no hook to set worker concurrency
 * through; jobbroker 1.12.0 added one (`JobWorkerPolicy`), so the value is now declared — which is
 * what `CARD_STAGE_WORKER` below exists to keep true. The number itself did not change with the
 * hook: it was 1 by inheritance, and stayed 1 through the wiring. An earlier reading of it as 2 came
 * from a sweep that caught two daemons running concurrently, not one daemon carrying two jobs.
 *
 * Now 2, deliberately, once the two things that made concurrency unsafe were fixed: card 0045
 * stopped stage commands inheriting the server's environment, and card 0081 locked every `pnpm
 * install`. Pinned here so the number moves on purpose rather than by accident.
 */
describe('CARD_STAGE_CONCURRENCY', () => {
    it('is 2, the number of stages this runner runs at once', () => {
        expect(CARD_STAGE_CONCURRENCY).toBe(2);
    });
});

/**
 * The worker policy is what makes `CARD_STAGE_CONCURRENCY` load-bearing instead of descriptive:
 * jobbroker passes it to `pgboss.work` as `localConcurrency`. If these two ever drift apart, the
 * constant goes back to being a comment about a number nothing reads — so this pins them together.
 */
describe('CARD_STAGE_WORKER', () => {
    it('runs card.stage at CARD_STAGE_CONCURRENCY, so the constant is the number the queue uses', () => {
        expect(CARD_STAGE_WORKER.concurrency).toBe(CARD_STAGE_CONCURRENCY);
    });

    it('leaves batchSize and pollInterval to pg-boss defaults, since only concurrency is a deliberate call here', () => {
        expect(CARD_STAGE_WORKER.batchSize).toBeUndefined();
        expect(CARD_STAGE_WORKER.pollInterval).toBeUndefined();
    });
});

/**
 * What actually carries `CARD_STAGE_WORKER` to pg-boss: jobbroker reads `worker` off the
 * registration and passes it to `pgboss.work` as `localConcurrency`. At a concurrency of 1 — the
 * same number pg-boss defaults to — a registration that dropped the policy would behave identically
 * to one that carries it, so nothing but this would notice the wiring going missing until someone
 * raised the constant and it silently did nothing.
 */
describe('JobsModule.setup', () => {
    /**
     * Enough of `AppConfig` for `setup`: every key it reads answers with a non-empty value, so the
     * `requireConfigString` guards pass. None of the values are used — the only thing that would
     * consume them is the `PgBoss` factory, which nothing here invokes.
     */
    const fakeConfig = (): AppConfig => ({ get: () => 'unused' }) as unknown as AppConfig;

    /**
     * Records what `setup` registers without building a container. `setup` only ever *describes*
     * registrations — the one factory that would construct a `PgBoss` is never invoked — so the
     * registry map it hands over can be read back straight from `useInstance`.
     */
    const recordingRegistry = (): { registry: Registry; instances: Map<unknown, unknown> } => {
        const instances = new Map<unknown, unknown>();
        const lifetimes = { asSingleton: () => {}, asTransient: () => {}, asScoped: () => {} };
        const registry = {
            register: (id: Identifier<unknown>) => ({
                useFactory: () => lifetimes,
                useClass: () => lifetimes,
                useInstance: (value: unknown) => {
                    instances.set(id, value);
                    return lifetimes;
                },
            }),
        } as unknown as Registry;
        return { registry, instances };
    };

    const cardStageRegistration = async () => {
        const { registry, instances } = recordingRegistry();
        await JobsModule.setup!(registry, fakeConfig());
        const jobRegistry = instances.get(PgBossJobRegistryMap) as PgBossJobRegistryMap;
        return jobRegistry.get('card.stage');
    };

    it('registers card.stage with the worker policy, so the declared concurrency reaches pg-boss', async () => {
        expect(await cardStageRegistration()).toMatchObject({ worker: CARD_STAGE_WORKER });
    });

    it('still registers card.stage with its queue policy alongside the worker policy', async () => {
        expect(await cardStageRegistration()).toMatchObject({ policy: CARD_STAGE_POLICY });
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

    it('logs the configured card.stage concurrency', async () => {
        const info = vi.fn();
        const logger = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        const jobRunner = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };

        await JobsModule.start!(fakeContainer(logger, jobRunner), new AbortController().signal);

        expect(info).toHaveBeenCalledWith(`card.stage concurrency: ${CARD_STAGE_CONCURRENCY}`);
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
