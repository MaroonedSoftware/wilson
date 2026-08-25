import { setTimeout as delay } from 'node:timers/promises';
import { Container, Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { Logger } from '@maroonedsoftware/logger';
import { JobBroker, JobRunner, registerJobContext, type JobQueuePolicy } from '@maroonedsoftware/jobbroker';
import { PgBossConnectionProvider, PgBossJobBroker, PgBossJobRegistryMap, PgBossJobRunner } from '@maroonedsoftware/jobbroker/pgboss';
import { PgBoss } from 'pg-boss';
import { Duration } from 'luxon';
import { configBoolean, configNumber, requireConfigString } from '#shared/require.config.js';
import { MAX_STAGE_WALL_CLOCK_MS } from '#modules/stages/stage.config.js';
import { CardStageJob, RunningCards } from './card.stage.job.js';
import { CardStageDeadJob } from './card.stage.dead.job.js';
import { CardJobs } from './card.jobs.js';
import { Poller } from './poller.js';
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
 * Backstop for `JobRunner.stop()` itself never returning.
 *
 * pg-boss's own graceful `stop()` already bounds itself (a 30s default): it waits that long for a
 * job to finish, and if one is still active when the window closes, gives up on it and returns
 * anyway — it does not wait for the handler's promise, only for its own internal bookkeeping. That
 * is short enough that `stop()` normally settles well inside this deadline; this exists only for the
 * rarer case where `stop()` itself hangs beyond its own bound — its cleanup stuck on the database,
 * say — so shutdown still proceeds rather than blocking forever on a promise that may never resolve.
 */
export const SHUTDOWN_DEADLINE_MS = 35_000;

/**
 * A card this process was still mid-run on when shutdown gave up waiting.
 */
export interface AbandonedCardJob {
    cardId: string;
    jobId: string;
}

export interface ShutdownReport {
    /** Cards this process was still mid-run on once shutdown gave up. Empty is a clean stop. */
    abandoned: AbandonedCardJob[];
}

/**
 * Stop accepting new `card.stage` work and report on whatever was still running once shutdown gave
 * up waiting for it.
 *
 * The trap this closes: pg-boss's own `stop()` stops fetching new work as its first act, waits for
 * the job actually running to settle, but — per the comment on `SHUTDOWN_DEADLINE_MS` — gives up and
 * *returns anyway* once its own internal timeout elapses, whether or not the handler ever finished. A
 * wedged handler therefore does not make `stop()` hang; it makes `stop()` resolve normally while the
 * handler keeps running in the background, which is exactly how a daemon can log a clean `stopped`
 * while a job sits `active` (the defect this card fixes). So "did `stop()`'s promise settle" is not
 * the question to ask; "is `RunningCards` still holding a card `stop()` claimed to be done with" is.
 * `SHUTDOWN_DEADLINE_MS` only guards the separate, rarer case of `stop()` not returning at all.
 *
 * Each card `RunningCards` still shows is confirmed live via `CardJobs.inFlight` before being
 * reported, since the tracker can be a beat stale — a card it still shows can have already settled
 * between `stop()` returning and this check running.
 */
export const stopCardStageJobs = async (runner: JobRunner, running: RunningCards, cardJobs: CardJobs): Promise<ShutdownReport> => {
    await Promise.race([runner.stop(), delay(SHUTDOWN_DEADLINE_MS)]);

    const abandoned: AbandonedCardJob[] = [];
    for (const cardId of running.snapshot()) {
        const jobId = await cardJobs.inFlight(cardId);
        if (jobId) abandoned.push({ cardId, jobId });
    }
    return { abandoned };
};

/**
 * Thrown by `BoundedCardStageJobRunner.stop()` when a card was still running once shutdown gave up
 * waiting for it, so a caller that already does nothing but `await runner.stop()` — `run.command.ts`
 * included — finds out its stop was not clean without needing a new dependency of its own; it just
 * has to look at what `stop()` did. The full, truthful accounting is on `abandoned`; `message` is
 * already the human-readable form so a bare `error.message` is enough for a caller that just wants
 * to log and move on.
 */
export class AbandonedCardJobsError extends Error {
    readonly abandoned: AbandonedCardJob[];

    constructor(abandoned: AbandonedCardJob[]) {
        const names = abandoned.map(({ cardId, jobId }) => `${cardId} (job ${jobId})`).join(', ');
        super(`${abandoned.length} card.stage job(s) still in flight, abandoned and will be redelivered: ${names}`);
        this.name = 'AbandonedCardJobsError';
        this.abandoned = abandoned;
    }
}

/**
 * The `JobRunner` every consumer actually resolves from the container: `start()` passes straight
 * through (and starts the poller, when one is configured), and `stop()` is `stopCardStageJobs`
 * wearing the plain `JobRunner` interface so a caller doesn't need to know `RunningCards` or
 * `CardJobs` exist to benefit from what they make possible. A clean stop resolves exactly as
 * `PgBossJobRunner.stop()` always has; a stop with something abandoned rejects with
 * `AbandonedCardJobsError` instead of silently resolving, so "the promise settled" can no longer be
 * mistaken for "everything finished" — which is the whole defect this card fixes.
 *
 * `poller` is `undefined` when `POLLER_ENABLED` is off (the default) — this is the whole mechanism
 * behind "off by default and killable": nothing about `start`/`stop` changes shape, there is just
 * nothing to start or stop, exactly as before this card existed.
 */
class BoundedCardStageJobRunner extends JobRunner {
    constructor(
        private readonly inner: JobRunner,
        private readonly running: RunningCards,
        private readonly cardJobs: CardJobs,
        private readonly poller: Poller | undefined,
    ) {
        super();
    }

    start(): Promise<void> {
        this.poller?.start();
        return this.inner.start();
    }

    async stop(): Promise<void> {
        // Stop the poller before asking what shutdown left abandoned: a poller still ticking
        // during shutdown could enqueue a card behind `stopCardStageJobs`'s back, and the whole
        // point of that report is to be the truth about in-flight work at the moment it is
        // written (card 0066), not a snapshot something else keeps changing underneath it.
        await this.poller?.stop();
        const report = await stopCardStageJobs(this.inner, this.running, this.cardJobs);
        if (report.abandoned.length > 0) {
            throw new AbandonedCardJobsError(report.abandoned);
        }
    }
}

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

        // Off by default: an operator runs the daemon as a pure drainer, exactly as before this
        // card, until this is deliberately turned on — and can turn it back off, with no code
        // change, the moment a poller misbehaves. See `Poller` (poller.ts) for what "misbehaves"
        // cannot mean: it enqueues nothing `whyNotDispatchable`/`CardJobs.inFlight` would refuse.
        const pollerEnabled = configBoolean(config, 'POLLER_ENABLED', false);

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

        // Singleton, not transient like CardStageJob itself: shutdown needs one registry shared
        // across every job execution this process runs, not a fresh one per scoped container.
        registry.register(RunningCards).useClass(RunningCards).asSingleton();
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

        // Singleton: the poller owns one interval timer for the process. `BoardConfig` and
        // `BoardRepository` are BoardModule's tokens, already registered by the time this runs
        // (module order in modules.ts) — resolved here the same way `RunningCards` and `CardJobs`
        // are below, not re-registered. Registered unconditionally — cheap, and constructing it does
        // no I/O — so the on/off decision lives in one place, the `pollerEnabled` check below.
        registry.register(Poller).useClass(Poller).asSingleton();

        // Default executor (pg-boss's own pool): enqueues here are not part of a surrounding
        // database transaction, so there is nothing to override.
        registry.register(PgBossConnectionProvider).useClass(PgBossConnectionProvider).asSingleton();

        registry.register(PgBossJobBroker).useClass(PgBossJobBroker).asSingleton();
        registry.register(JobBroker).useClass(PgBossJobBroker).asSingleton();
        registry
            .register(JobRunner)
            .useFactory(container => {
                const pgBossRunner = new PgBossJobRunner(
                    container,
                    container.get(PgBossJobRegistryMap),
                    container.get(PgBoss),
                    container.get(Logger),
                );
                return new BoundedCardStageJobRunner(
                    pgBossRunner,
                    container.get(RunningCards),
                    container.get(CardJobs),
                    pollerEnabled ? container.get(Poller) : undefined,
                );
            })
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
    // Stops accepting new jobs and waits, bounded, for in-flight ones to finish before Data tears
    // down the pool underneath them. `JobRunner.stop()` (see BoundedCardStageJobRunner above) is what
    // actually does the bounding and reporting, surfacing a card still abandoned past the deadline as
    // a rejection; this logs it and swallows it, so abandonment does not stop the rest of shutdown
    // (Data's pool teardown among it) from running.
    shutdown: async (container: Container) => {
        try {
            await container.get(JobRunner).stop();
        } catch (error) {
            if (!(error instanceof AbandonedCardJobsError)) throw error;
            container.get(Logger).error(error.message);
        }
    },
};
