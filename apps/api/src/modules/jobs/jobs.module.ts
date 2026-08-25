import { Container, Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { Logger } from '@maroonedsoftware/logger';
import { JobBroker, JobRunner, registerJobContext, type JobQueuePolicy } from '@maroonedsoftware/jobbroker';
import { PgBossConnectionProvider, PgBossJobBroker, PgBossJobRegistryMap, PgBossJobRunner } from '@maroonedsoftware/jobbroker/pgboss';
import { PgBoss } from 'pg-boss';
import { Duration } from 'luxon';
import { configNumber, requireConfigString } from '#shared/require.config.js';
import { MAX_STAGE_WALL_CLOCK_MS } from '#modules/stages/stage.config.js';
import { CardStageJob } from './card.stage.job.js';
import { CardStageDeadJob } from './card.stage.dead.job.js';
import { CardJobs } from './card.jobs.js';
import { CARD_STAGE_CONCURRENCY } from './job.runner.config.js';

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
 *
 * `retryLimit` is 3, not 2: pg-boss's own expiry sweep (`failJobsByTimeout`, and the identical path
 * a job stuck `active` past `expiresIn` takes when its worker is killed mid-run — "pg-boss shut down
 * while active") re-inserts through the same `retry_count < retry_limit` check as a thrown error, so
 * an expiry or an orphaned-then-redelivered job spends this budget exactly like an ordinary failure
 * (pg-boss `plans.js`, `failJobsBody`; `manager.js`, `reinsertFailedJobs`). That is the right thing
 * for it to do — a worker dying mid-run is the "dropped connection" case this policy is for — but it
 * means one slot can be spent before the stage's own logic ever runs again. Card 0035's real attempt
 * had none left when this happened, because its first two attempts were deterministic refusals that
 * should never have spent a retry at all; that is fixed by `assertDispatchable` throwing
 * `NotDispatchableError` and `CardStageJob` routing it to `poison`/`dispatch.deferred` instead of
 * throwing for pg-boss to retry. The extra retry here is headroom for the case that fix does not
 * touch: an expiry or redelivery consuming a slot before a stage gets to run its own logic at all.
 */
export const CARD_STAGE_POLICY: JobQueuePolicy = {
    retryLimit: 3,
    retryDelay: Duration.fromObject({ seconds: 30 }),
    retryBackoff: true,
    expiresIn: CARD_STAGE_EXPIRES_IN,
    deadLetter: 'card.stage.dead',
};

/**
 * Retry policy for `card.stage.dead`: no retries and no dead letter of its own.
 *
 * This handler is what finally reads a dead-lettered `card.stage` job and reacts to it — a queue
 * nobody was subscribed to, subscribed. It must not be able to dead-letter itself: a failure inside
 * it (a database hiccup while poisoning the card, say) should log and stop, exactly like any other
 * unhandled job error, not spend a retry budget or recurse into a second dead-letter queue that
 * would be just as unread as the first one was.
 */
export const CARD_STAGE_DEAD_POLICY: JobQueuePolicy = {
    retryLimit: 0,
};

/**
 * The job queue.
 *
 * pg-boss on the same Postgres database as everything else — no separate broker to run or operate.
 * One queue for now, `card.stage`, which `CardStageJob` re-enqueues onto itself to walk a card
 * through consecutive `agent` stages without a human re-triggering each one.
 *
 * At most `CARD_STAGE_CONCURRENCY` (job.runner.config.ts) of those jobs run at once — pg-boss's own
 * default, since jobbroker gives this module no way to raise or lower it.
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
        // CardStageDeadJob reads which job is currently running it (JobContext.id) to look its own
        // dead-letter row back up for the failed attempt's output — register the token so that
        // injection resolves instead of throwing.
        registerJobContext(registry);
        registry.register(CardStageDeadJob).useClass(CardStageDeadJob).asTransient();

        const jobRegistry = new PgBossJobRegistryMap();
        jobRegistry.set('card.stage', { job: CardStageJob, policy: CARD_STAGE_POLICY });
        jobRegistry.set('card.stage.dead', { job: CardStageDeadJob, policy: CARD_STAGE_DEAD_POLICY });
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
        // See CARD_STAGE_CONCURRENCY (job.runner.config.ts): this is pg-boss's own default,
        // inherited unconfigured because jobbroker has no hook to set it through. Logged so the
        // ceiling on simultaneously running stages is visible without reading either source.
        container.get(Logger).info(`card.stage concurrency: ${CARD_STAGE_CONCURRENCY} (pg-boss default; jobbroker has no hook to configure it)`);
        await container.get(JobRunner).start();
    },
    // Stops accepting new jobs and waits for in-flight ones to finish before Data tears down the
    // pool underneath them.
    shutdown: async (container: Container) => {
        await container.get(JobRunner).stop();
    },
};
