import { Container, Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { Logger } from '@maroonedsoftware/logger';
import { JobBroker, JobRunner, type JobQueuePolicy } from '@maroonedsoftware/jobbroker';
import { PgBossConnectionProvider, PgBossJobBroker, PgBossJobRegistryMap, PgBossJobRunner } from '@maroonedsoftware/jobbroker/pgboss';
import { PgBoss } from 'pg-boss';
import { Duration } from 'luxon';
import { configNumber, requireConfigString } from '#shared/require.config.js';
import { MAX_STAGE_WALL_CLOCK_MS } from '#modules/stages/stage.config.js';
import { CardStageJob } from './card.stage.job.js';
import { CardJobs } from './card.jobs.js';

/**
 * How long a `card.stage` job may run before the queue calls it stuck and hands it to another
 * worker.
 *
 * Left unset, this was pg-boss's default of fifteen minutes while a stage's own wall clock defaulted
 * to thirty — so a stage that legitimately ran past fifteen minutes had its job redelivered while
 * the first attempt was still going, putting two agents in one worktree on one branch. The stage cap
 * is `MAX_STAGE_WALL_CLOCK_MS` and the schema enforces it; the difference is headroom for everything
 * a job does around the run itself: cutting the worktree, installing dependencies, verifying, and
 * writing the transition.
 */
export const CARD_STAGE_EXPIRES_IN = Duration.fromMillis(MAX_STAGE_WALL_CLOCK_MS).plus({ minutes: 10 });

/**
 * Retry policy for `card.stage`: a couple of quick retries for a transient failure (a dropped
 * connection, a flaky provider call), then dead-letter rather than retry forever — a stage that
 * keeps failing needs a human, not an infinite queue.
 */
export const CARD_STAGE_POLICY: JobQueuePolicy = {
    retryLimit: 2,
    retryDelay: Duration.fromObject({ seconds: 30 }),
    retryBackoff: true,
    expiresIn: CARD_STAGE_EXPIRES_IN,
    deadLetter: 'card.stage.dead',
};

/**
 * The job queue.
 *
 * pg-boss on the same Postgres database as everything else — no separate broker to run or operate.
 * One queue for now, `card.stage`, which `CardStageJob` re-enqueues onto itself to walk a card
 * through consecutive `agent` stages without a human re-triggering each one.
 */
export const JobsModule: ServerKitModule = {
    name: 'Jobs',
    setup: async (registry: Registry, config: AppConfig) => {
        const dbConfig = {
            host: requireConfigString(config, 'DATABASE_HOST'),
            port: configNumber(config, 'DATABASE_PORT', 5432),
            user: requireConfigString(config, 'DATABASE_USER'),
            password: requireConfigString(config, 'DATABASE_PASSWORD'),
            database: requireConfigString(config, 'DATABASE_NAME'),
        };

        registry
            .register(PgBoss)
            .useFactory(container => {
                const pgboss = new PgBoss(dbConfig);
                // Mirrors DataModule's pool: an error with no in-flight caller has nowhere else to
                // go and would otherwise take the process down as an unhandled 'error' event.
                pgboss.on('error', err => container.get(Logger).error(err));
                return pgboss;
            })
            .asSingleton();

        registry.register(CardStageJob).useClass(CardStageJob).asTransient();

        const jobRegistry = new PgBossJobRegistryMap();
        jobRegistry.set('card.stage', { job: CardStageJob, policy: CARD_STAGE_POLICY });
        registry.register(CardJobs).useClass(CardJobs).asTransient();
        registry.register(PgBossJobRegistryMap).useInstance(jobRegistry);

        // Default executor (pg-boss's own pool): enqueues here are not part of a surrounding
        // database transaction, so there is nothing to override.
        registry.register(PgBossConnectionProvider).useClass(PgBossConnectionProvider).asSingleton();

        registry.register(PgBossJobBroker).useClass(PgBossJobBroker).asSingleton();
        registry.register(JobBroker).useClass(PgBossJobBroker).asSingleton();
        registry
            .register(JobRunner)
            .useFactory(
                container => new PgBossJobRunner(container, container.get(PgBossJobRegistryMap), container.get(PgBoss), container.get(Logger)),
            )
            .asSingleton();
    },
    // Started after Data (the pool `card.stage` reads/writes against) and Stages (what
    // `CardStageJob` dispatches into) — module order in modules.ts controls that.
    start: async (container: Container) => {
        await container.get(JobRunner).start();
    },
    // Stops accepting new jobs and waits for in-flight ones to finish before Data tears down the
    // pool underneath them.
    shutdown: async (container: Container) => {
        await container.get(JobRunner).stop();
    },
};
