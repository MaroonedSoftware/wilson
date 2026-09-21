import { setTimeout as delay } from 'node:timers/promises';
import { Container, Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { Logger } from '@maroonedsoftware/logger';
import { JobBroker, JobRunner, registerJobContext, type JobQueuePolicy, type JobWorkerPolicy } from '@maroonedsoftware/jobbroker';
import { PgBossConnectionProvider, PgBossJobBroker, PgBossJobRegistryMap, PgBossJobRunner } from '@maroonedsoftware/jobbroker/pgboss';
import { PgBoss } from 'pg-boss';
import { Duration } from 'luxon';
import { runAsProject } from '#modules/board/project.context.js';
import { configNumber, requireConfigString } from '#shared/require.config.js';
import { MAX_STAGE_WALL_CLOCK_MS } from '#modules/stages/stage.config.js';
import { PollerSettingService } from '#modules/settings/poller.setting.service.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { CARD_STAGE_CONCURRENCY } from '#modules/settings/card.stage.concurrency.setting.js';
import { POLLER_INTERVAL_MS } from '#modules/settings/poller.interval.setting.js';
import { CardStageJob } from './card.stage.job.js';
import { RunningCards } from './running.cards.js';
import { CardStageDeadJob } from './card.stage.dead.job.js';
import { CardJobs } from './card.jobs.js';
import { Poller } from './poller.js';
import { CARD_STAGE_CONCURRENCY_DEFAULT, POLLER_INTERVAL_MS_DEFAULT } from './job.runner.config.js';

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
 * Worker policy for `card.stage`: how many of these jobs *this process* runs at once.
 *
 * The counterpart to `CARD_STAGE_POLICY` above, and a different question — that one is stored on the
 * queue and governs what happens to a job that fails; this one configures the worker this daemon
 * starts and governs how fast jobs come off the queue. Another node consuming the same queue could
 * legitimately use a different value, and changing this takes effect on the next start rather than
 * for everyone at once.
 *
 * `concurrency` is the only field set: `batchSize` stays at pg-boss's default of one job per fetch
 * (a batch settles per job under jobbroker's `perJobResults`, but a stage is minutes of agent work,
 * not something worth fetching in bulk), and `pollInterval` stays at pg-boss's default because
 * nothing here waits on sub-second dispatch latency — `POLLER_INTERVAL_MS` is thirty seconds.
 *
 * See `CARD_STAGE_CONCURRENCY_DEFAULT` (job.runner.config.ts) for the number itself and why it is 3.
 *
 * Deliberately not re-created with a fresh object each time the concurrency setting changes:
 * `PgBossJobRunner.start()` (`resolveWorkerPolicy`, the library's `pgboss.js`) reads `registration
 * .worker` — this exact object, held by reference in `PgBossJobRegistryMap` below — anew every time
 * `.start()` runs, per its own doc ("changing one takes effect on the next runner start rather than
 * for everyone at once"). `BoundedCardStageJobRunner.reconcileConcurrency` mutates `.concurrency` in
 * place for exactly that reason: mutating this object and then re-running `.start()` is the whole
 * mechanism, and a second `JobWorkerPolicy` object here would go unread.
 *
 * Card 0149's concurrency decision: this stays a **global** budget, shared by every registered
 * project, not a per-project one. There is exactly one `card.stage` queue and one worker
 * (`PgBossJobRegistryMap` below registers `card.stage` once, not once per project), and a
 * `CardStagePayload.project` is data on a job in that one queue, not a second queue name — the same
 * choice `CARD_STAGE_CONCURRENCY`'s own doc comment (`settings/card.stage.concurrency.setting.ts`)
 * already makes for a *single* project, restated here for many: each unit of concurrency is a git
 * worktree, a `pnpm install` and a live agent process on *this host*, and that machine-load question
 * does not become smaller because the worktrees happen to belong to different projects — three
 * projects at three each is still nine concurrent engines against one workstation. A per-project
 * budget would need `card.stage` split into one queue per project (each with its own
 * `JobWorkerPolicy`), which is a bigger structural change than this card's Constraints call for and
 * not needed to satisfy any of its acceptance criteria; nothing here rules it out for a later card if
 * per-project fairness ever becomes the actual complaint, as opposed to host capacity.
 */
export const CARD_STAGE_WORKER: JobWorkerPolicy = {
    concurrency: CARD_STAGE_CONCURRENCY_DEFAULT,
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
 *
 * This is also, most likely, the same root cause behind a second error pg-boss logs on its own
 * during a stage that was still active when shutdown started: `Worker.stop` awaiting a job's
 * handler promise that pg-boss's own graceful window gave up on, the promise later settling and its
 * completion path (`Manager.fail`) running against a connection `PgBoss.stop()` had by then already
 * closed. Same shape as the bug this card fixes — something touching the connection after `stop()`
 * has torn it down — but entirely inside pg-boss's own `stop()` call, not a call this codebase makes
 * afterwards, so there is nothing here to change it from the outside. Left alone, per this card's
 * scope; noted so the next person does not spend time chasing it as a separate defect.
 */
export const SHUTDOWN_DEADLINE_MS = 35_000;

/**
 * A card this process was still mid-run on when shutdown gave up waiting.
 */
export interface AbandonedCardJob {
    cardId: string;
    jobId: string;
}

/**
 * A card `RunningCards` still showed once shutdown gave up, whose post-stop confirmation itself
 * failed — neither "settled" nor "still running" was answerable. `reason` is the failure's own
 * message, kept so the report says what went wrong rather than just that something did.
 */
export interface UnconfirmedCardJob {
    cardId: string;
    reason: string;
}

export interface ShutdownReport {
    /** Cards this process was still mid-run on once shutdown gave up. Empty is a clean stop. */
    abandoned: AbandonedCardJob[];
    /**
     * Cards `RunningCards` still showed that could not be confirmed settled or abandoned at all —
     * the post-stop read itself failed. Distinct from both other states: unlike a clean stop, the
     * card is not known to have settled; unlike `abandoned`, it is not known to still be running
     * either. Empty alongside an empty `abandoned` is what a genuinely clean stop looks like.
     */
    unconfirmed: UnconfirmedCardJob[];
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
 * Each card `RunningCards` still shows is confirmed live via `CardJobs.confirmInFlightAfterStop`
 * before being reported, since the tracker can be a beat stale — a card it still shows can have
 * already settled between `stop()` returning and this check running. That confirmation runs after
 * `runner.stop()` has already closed pg-boss's own connection, so it deliberately does not use
 * `CardJobs.inFlight` — that method asks the broker, which asks pg-boss's manager, which throws
 * once the connection is closed. `confirmInFlightAfterStop` reads the same job state a different
 * way, over a connection that is still open; see its doc comment for why that is sound.
 *
 * A card whose confirmation itself fails — the read throws rather than answering settled or
 * abandoned — is neither: it is not swallowed into a clean report, and it is not guessed at as
 * abandoned. It is collected into `unconfirmed` instead, a third, truthful state, and left for the
 * caller to say loudly rather than hide.
 *
 * Card 0149: `CardJobs.confirmInFlightAfterStop` reads `BoardConfig.project` (`this.config.project`)
 * with no scope of its own, so each call is wrapped in `runAsProject(project, ...)` for the project
 * `RunningCards` recorded that entry under — the same project `CardStageJob.run` resolved and opened
 * its own `runAsProject` scope with. Without this, every confirmation here would resolve
 * `BoardConfig` to the daemon's own configured project regardless of which project the card actually
 * ran under, querying that project's `runner.cardJobs` row instead — finding nothing, and reporting a
 * genuinely abandoned card as cleanly settled for every project but the default one.
 */
export const stopCardStageJobs = async (runner: JobRunner, running: RunningCards, cardJobs: CardJobs): Promise<ShutdownReport> => {
    await Promise.race([runner.stop(), delay(SHUTDOWN_DEADLINE_MS)]);

    const abandoned: AbandonedCardJob[] = [];
    const unconfirmed: UnconfirmedCardJob[] = [];
    for (const { project, cardId } of running.snapshot()) {
        try {
            const jobId = await runAsProject(project, () => cardJobs.confirmInFlightAfterStop(cardId));
            if (jobId) abandoned.push({ cardId, jobId });
        } catch (error) {
            unconfirmed.push({ cardId, reason: error instanceof Error ? error.message : String(error) });
        }
    }
    return { abandoned, unconfirmed };
};

/**
 * Thrown by `BoundedCardStageJobRunner.stop()` when a stop was not clean — a card was still running
 * once shutdown gave up waiting for it, or shutdown could not even confirm whether one was — so a
 * caller that already does nothing but `await runner.stop()` — `run.command.ts` included — finds out
 * without needing a new dependency of its own; it just has to look at what `stop()` did. The full,
 * truthful accounting is on `abandoned` and `unconfirmed`; `message` is already the human-readable
 * form so a bare `error.message` is enough for a caller that just wants to log and move on.
 */
export class AbandonedCardJobsError extends Error {
    readonly abandoned: AbandonedCardJob[];
    readonly unconfirmed: UnconfirmedCardJob[];

    constructor(abandoned: AbandonedCardJob[], unconfirmed: UnconfirmedCardJob[] = []) {
        const parts: string[] = [];
        if (abandoned.length > 0) {
            const names = abandoned.map(({ cardId, jobId }) => `${cardId} (job ${jobId})`).join(', ');
            parts.push(`${abandoned.length} card.stage job(s) still in flight, abandoned and will be redelivered: ${names}`);
        }
        if (unconfirmed.length > 0) {
            const names = unconfirmed.map(({ cardId, reason }) => `${cardId} (${reason})`).join(', ');
            parts.push(`could not confirm ${unconfirmed.length} card(s) settled or abandoned: ${names}`);
        }
        super(parts.join('; '));
        this.name = 'AbandonedCardJobsError';
        this.abandoned = abandoned;
        this.unconfirmed = unconfirmed;
    }
}

/**
 * The `JobRunner` every consumer actually resolves from the container: `start()` passes straight
 * through (after applying whatever the poller setting currently resolves to), and `stop()` is
 * `stopCardStageJobs` wearing the plain `JobRunner` interface so a caller doesn't need to know
 * `RunningCards` or `CardJobs` exist to benefit from what they make possible. A clean stop resolves
 * exactly as `PgBossJobRunner.stop()` always has; a stop with something abandoned rejects with
 * `AbandonedCardJobsError` instead of silently resolving, so "the promise settled" can no longer be
 * mistaken for "everything finished" — which is the whole defect this card fixes.
 *
 * `poller` is registered and constructed unconditionally now (card 0106) — whether it actually
 * runs is `PollerSettingService`'s question, not this class's constructor's. Off by default still
 * holds: `PollerSettingService` resolves to `POLLER_ENABLED` (default `false`) absent a
 * `runner.settings` row, and `Poller.stop()` (called on every `start()` when the answer is "off")
 * is safe on a poller that was never running.
 *
 * Card 0115 adds `card-stage-concurrency`, and applying it here is the hard half of that card.
 * `Poller.loop` can just re-read `POLLER_INTERVAL_MS` every tick (poller.ts) because nothing about
 * that setting is stored anywhere but the setting's own row. Concurrency is different: pg-boss
 * fixes a queue's worker count at `pgboss.work()` time (`PgBossJobRunner.start()`, the library's
 * `pgboss.js` — the dispatch closure `work()` is given is built fresh inside that method and kept
 * nowhere this codebase can reach), and there is no public, per-queue "change this worker's
 * concurrency" call — the *library's own* `JobWorkerPolicy` doc says as much ("changing one takes
 * effect on the next runner start"). The only lever this codebase has at all is restarting the
 * whole runner (`inner.stop()` + `inner.start()`), and `PgBossJobRunner.stop()` calls pg-boss's own
 * `stop()` with no arguments — its default 30-second graceful window, chosen for process shutdown,
 * not for a stage that legitimately runs for minutes (`MAX_STAGE_WALL_CLOCK_MS`). Restarting the
 * runner while a stage is running would either wait needlessly or — past that window — abandon it,
 * exactly the failure `stopCardStageJobs`/`AbandonedCardJobsError` exist to report, not to cause.
 *
 * So a concurrency change is never pushed into a running worker: `startConcurrencyWatcher` (called
 * from `start()`, stopped from `stop()`) checks, on the same cadence as the poller
 * (`POLLER_INTERVAL_MS`, read fresh each cycle so it tracks the poller's own interval changes too),
 * whether the persisted `card-stage-concurrency` differs from what is currently applied. If
 * `RunningCards` is non-empty it defers to the next cycle — untouched, no matter how long that
 * takes; it re-checks the same way immediately after pausing the poller too, since that pause is
 * itself an await a stage can start inside. Only once the board is genuinely idle does it mutate `CARD_STAGE_WORKER.concurrency` (the
 * live object `PgBossJobRegistryMap` already holds a reference to — see that constant's own doc)
 * and cycle `inner.stop()`/`inner.start()`, which is safe specifically because nothing is running
 * for pg-boss's 30-second window to matter: `stop()` has nothing to wait out. This is the plain
 * answer to "pg-boss cannot change a worker's concurrency without restarting it": the setting takes
 * effect at the next opportunity the daemon is idle, checked on every poll, never sooner.
 *
 * Exported so a test can construct one directly against fakes, the same way `stopCardStageJobs`
 * and `AbandonedCardJobsError` already are.
 */
export class BoundedCardStageJobRunner extends JobRunner {
    private appliedConcurrency: number = CARD_STAGE_WORKER.concurrency ?? CARD_STAGE_CONCURRENCY_DEFAULT;
    private concurrencyWatcherAbort: AbortController | undefined;
    private concurrencyWatcherLoop: Promise<void> | undefined;
    // Last interval `watchConcurrency` successfully read from `settings`, so a failing read has
    // something better than `POLLER_INTERVAL_MS_DEFAULT` to fall back to. See `watchConcurrency`'s
    // own doc comment (card 0271).
    private lastIntervalMs: number | undefined;

    constructor(
        private readonly inner: JobRunner,
        private readonly running: RunningCards,
        private readonly cardJobs: CardJobs,
        private readonly poller: Poller,
        private readonly pollerSettings: PollerSettingService,
        private readonly settings: SettingsStore,
        private readonly logger: Logger,
    ) {
        super();
    }

    async start(): Promise<void> {
        // Resolved and applied to the live worker-policy object *before* `inner.start()` reads it
        // (PgBossJobRunner.start() → resolveWorkerPolicy → CARD_STAGE_WORKER), so a database row or
        // CARD_STAGE_CONCURRENCY already in place takes effect at this boot exactly like a
        // POLLER_ENABLED row already does, one line below.
        this.appliedConcurrency = await this.settings.get(CARD_STAGE_CONCURRENCY);
        CARD_STAGE_WORKER.concurrency = this.appliedConcurrency;

        // What used to be a one-time, boot-only `pollerEnabled` check in `setup` below is this
        // instead — asked again every time `start()` runs, so a database row already in place
        // takes effect the same way a write made after boot does (PollerSettingService.set).
        await this.pollerSettings.applyCurrentValue();
        await this.inner.start();
        this.startConcurrencyWatcher();
    }

    async stop(): Promise<void> {
        this.concurrencyWatcherAbort?.abort();
        await this.concurrencyWatcherLoop;

        // Stop the poller before asking what shutdown left abandoned: a poller still ticking
        // during shutdown could enqueue a card behind `stopCardStageJobs`'s back, and the whole
        // point of that report is to be the truth about in-flight work at the moment it is
        // written (card 0066), not a snapshot something else keeps changing underneath it.
        await this.poller.stop();
        const report = await stopCardStageJobs(this.inner, this.running, this.cardJobs);
        if (report.abandoned.length > 0 || report.unconfirmed.length > 0) {
            throw new AbandonedCardJobsError(report.abandoned, report.unconfirmed);
        }
    }

    /**
     * A loop separate from `Poller`'s own — not a call `Poller.tick()` makes — so that
     * `reconcileConcurrency`'s `await this.poller.stop()` below can never be a tick awaiting its
     * own containing `Poller.loop()` promise. Same cadence, different promise chain.
     */
    private startConcurrencyWatcher(): void {
        this.concurrencyWatcherAbort = new AbortController();
        this.concurrencyWatcherLoop = this.watchConcurrency(this.concurrencyWatcherAbort.signal);
    }

    /**
     * Card 0271: on 2026-09-21 the compose stack restarted and the daemon died on `ECONNREFUSED`
     * thrown by `SettingsStore.get` from this loop's interval read — it sat outside any `try`, so a
     * failing read here became an unhandled rejection that took the whole process down. Card 0257
     * fixed the identical shape in `Poller.loop` (`poller.ts`); this loop, the source poller
     * (`source.poller.ts`), and the status mirror poller (`status.mirror.poller.ts`) each read their
     * own interval the same unguarded way, and this card closes all three.
     *
     * A failing read is logged through `logger` and falls back to `lastIntervalMs`, the last interval
     * this loop successfully read, or `POLLER_INTERVAL_MS_DEFAULT` when it has never read one — so a
     * database outage makes this loop wait and retry, never busy-loop, and never again take the
     * daemon with it. No reconnection logic: kysely's pool reconnects on the next query once Postgres
     * is back, which is why "keep looping" is the whole fix.
     */
    private async watchConcurrency(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            let intervalMs: number;
            try {
                intervalMs = await this.settings.get(POLLER_INTERVAL_MS);
                this.lastIntervalMs = intervalMs;
            } catch (error) {
                this.logger.error(error);
                intervalMs = this.lastIntervalMs ?? POLLER_INTERVAL_MS_DEFAULT;
            }
            try {
                await delay(intervalMs, undefined, { signal });
            } catch {
                return;
            }
            await this.reconcileConcurrency();
        }
    }

    /**
     * Applies a changed `card-stage-concurrency` setting, but only once `RunningCards` is empty —
     * see this class's own doc for why that is the one moment a runner restart is safe. A change
     * seen while stages are running is not lost, just deferred: the next cycle asks again.
     */
    private async reconcileConcurrency(): Promise<void> {
        try {
            const desired = await this.settings.get(CARD_STAGE_CONCURRENCY);
            if (desired === this.appliedConcurrency) return;
            if (this.running.snapshot().length > 0) return;

            // Pausing the poller for this window is not for safety — nothing is running, so
            // `inner.stop()` has nothing to wait out either way — it only closes the narrow gap
            // where a tick could call `broker.send` against the connection `inner.stop()` is
            // mid-way through tearing down. Safe to call from here (unlike from inside
            // `Poller.tick()` itself): this method runs on `watchConcurrency`'s own loop, a
            // different promise chain from `Poller.loop()`, so `poller.stop()` awaits a promise
            // this call is not itself part of.
            await this.poller.stop();

            // Re-check: the await above is a gap the first check (line above) cannot see across —
            // a tick already in flight when that check ran, or a stage re-enqueuing its own next
            // stage, can still land a card.stage job on a worker that is still up and have it start
            // (RunningCards.add) before this line runs. Restarting into that would silently catch
            // it, exactly the "disturb a running stage" failure this class exists to avoid. Defer
            // instead — same as the first check — and let the next cycle try again once idle.
            if (this.running.snapshot().length > 0) {
                await this.pollerSettings.applyCurrentValue();
                this.logger.info(`card.stage concurrency: deferred ${desired} (a stage started while pausing the poller)`);
                return;
            }

            CARD_STAGE_WORKER.concurrency = desired;
            await this.inner.stop();
            await this.inner.start();
            // `inner.start()` only re-registers pg-boss's workers; the poller's own on/off state is
            // this class's to reapply, same as in `start()` above.
            await this.pollerSettings.applyCurrentValue();
            this.appliedConcurrency = desired;
            this.logger.info(`card.stage concurrency: applied ${desired} (queue was idle)`);
        } catch (error) {
            this.logger.error(error);
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
 * At most `CARD_STAGE_CONCURRENCY` (`settings/card.stage.concurrency.setting.ts`, card 0115) of
 * those jobs run at once, declared on the registration below as `CARD_STAGE_WORKER` rather than
 * inherited from pg-boss's default.
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
        jobRegistry.set('card.stage', { job: CardStageJob, policy: CARD_STAGE_POLICY, worker: CARD_STAGE_WORKER });
        jobRegistry.set('card.stage.dead', { job: CardStageDeadJob, policy: CARD_STAGE_DEAD_POLICY });
        registry.register(CardJobs).useClass(CardJobs).asTransient();
        registry.register(PgBossJobRegistryMap).useInstance(jobRegistry);

        // Singleton: the poller owns one interval timer for the process. `BoardConfig` and
        // `BoardRepository` are BoardModule's tokens, already registered by the time this runs
        // (module order in modules.ts) — resolved here the same way `RunningCards` and `CardJobs`
        // are below, not re-registered. Registered unconditionally — cheap, and constructing it does
        // no I/O — so the on/off decision lives in one place: `PollerSettingService`, asked by
        // `BoundedCardStageJobRunner.start()` below rather than decided once, here, at setup time.
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
                    container.get(Poller),
                    container.get(PollerSettingService),
                    container.get(SettingsStore),
                    container.get(Logger),
                );
            })
            .asSingleton();
    },
    // Started after Data (the pool `card.stage` reads/writes against) and Stages (what
    // `CardStageJob` dispatches into) — module order in modules.ts controls that.
    start: async (container: Container) => {
        await container.get(JobRunner).start();
        // Logged after `start()`, not before: `BoundedCardStageJobRunner.start()` is what resolves
        // the `card-stage-concurrency` setting (card 0115) and writes it onto `CARD_STAGE_WORKER`, so
        // this is the daemon's own startup output saying what it actually chose, not what the
        // coded default happens to be.
        container.get(Logger).info(`card.stage concurrency: ${CARD_STAGE_WORKER.concurrency}`);
    },
    // Stops accepting new jobs and waits, bounded, for in-flight ones to finish before Data tears
    // down the pool underneath them. `JobRunner.stop()` (see BoundedCardStageJobRunner above) is what
    // actually does the bounding and reporting, surfacing a card still abandoned or unconfirmed past
    // the deadline as a rejection; this logs it and swallows it, so that does not stop the rest of
    // shutdown (Data's pool teardown among it) from running.
    //
    // The broker call *this hook itself* used to make after `runner.stop()` was `CardJobs.inFlight`,
    // called from `stopCardStageJobs` and now `CardJobs.confirmInFlightAfterStop`, which reads
    // `pgboss.job` over the app's own connection instead. `Poller.tick`'s `inFlight`/`broker.send`
    // are not a problem either: `poller.stop()` runs above `stopCardStageJobs` in
    // `BoundedCardStageJobRunner.stop()`.
    //
    // That is not the same as saying nothing else can reach the broker on a closed connection.
    // `stop()` gives up and returns once its own timeout elapses **while a handler keeps running** —
    // that is the whole premise of card 0066 and of the report above. A `CardStageJob.run` that
    // reaches its chain point after that returns calls `broker.send` (card.stage.job.ts:107) on a
    // closed connection, and `CardStageDeadJob.run` calls `pgboss.getJobById`
    // (card.stage.dead.job.ts:64) the same way. Both throw the same assertion this card fixed here,
    // from a job handler rather than from shutdown. Card 0102 covers them; do not read this comment
    // as a claim that the path is clear.
    shutdown: async (container: Container) => {
        try {
            await container.get(JobRunner).stop();
        } catch (error) {
            if (!(error instanceof AbandonedCardJobsError)) throw error;
            container.get(Logger).error(error.message);
        }
    },
};
