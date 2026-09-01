/**
 * How many `card.stage` jobs may run at once, on this daemon process.
 *
 * Declared, not inherited. jobbroker 1.12.0 added `JobWorkerPolicy` — `concurrency`, `batchSize`,
 * `pollInterval` — settable per registration (`PgBossJobRegistration.worker`) or runner-wide
 * (`PgBossJobRunner.defaultWorkerPolicy`), and `PgBossJobRunner.start()` now passes it to
 * `pgboss.work` as `localConcurrency`/`batchSize`/`pollingIntervalSeconds`. `JobsModule` sets
 * `worker: CARD_STAGE_WORKER` on the `card.stage` registration from this constant, so this is the
 * number the queue actually runs on rather than a comment describing someone else's default.
 *
 * Before that hook existed, `PgBossJobRunner.start()` called `pgboss.work(name, handler)` with no
 * options and every queue fell back to pg-boss's own default of one worker fetching one job at a
 * time (pg-boss `manager.js`, `Manager#work`: `localConcurrency = 1, batchSize = 1`; each spawned
 * worker's loop `await`s a fetched job to finish before fetching again, `worker.js`, `Worker#run`).
 * That default is where the value 1 originally came from. It is no longer the value: 1 was kept
 * while the number was inherited, then raised to 2 and to 3 once it was declared, each raise on a
 * measurement of this workstation rather than a preference. Being able to set the number still does
 * not answer what it should be; see the paragraph below for what does.
 *
 * It was briefly and wrongly recorded as 2. A sweep over `stage.dispatched`/`stage.passed` pairs in
 * `runner.card_events` appeared to show two simultaneous stages, but that overlap was two *daemons*
 * running at once — a `wilson run` process and an API server, which is the very confusion card 0079
 * exists to remove — not one daemon carrying two jobs. Card 0063 read the code and got this right;
 * the "measurement" that overrode it measured the wrong thing. Observed directly afterwards: two
 * cards enqueued a second apart, and the second sat in `created` until the first finished.
 *
 * Raising it is a separate call from being able to raise it. Each concurrent stage is a git
 * worktree, a `pnpm install`, and an agent, so the number trades disk and memory headroom for
 * throughput — that needs measuring the host it runs on.
 *
 * That measurement has since been made twice, which is how this reached 3. At 2: load average 5.07
 * across 18 CPUs, 5.7GB free plus 12.7GB reclaimable, the runner barely registering, because agents
 * spend most of their time waiting on the model API and card 0081's lock already serialises the
 * installs. The host is not what binds. Scope collisions, the merge gate and the testing stage's
 * CPU cost bind first, so the next raise wants evidence that one of those has moved, not evidence
 * of spare CPU.
 *
 * "On this daemon process" is also why `run.command.ts`'s `pnpmStoreLock` (card 0081, guarding
 * concurrent `pnpm install`s against pnpm's shared store) is a plain in-process lock rather than a
 * lockfile or a DB advisory lock: `concurrency` is pg-boss's *local* worker count, so every stage
 * this constant bounds is a job handler in the same event loop, and a lock that only needs to work
 * within one process is exactly as strong a guarantee as the concurrency this constant admits.
 * Raising this number stays bounded to one process too — a second daemon consuming the same queue
 * gets its own workers and its own copy of that lock, which is the case the lock would need to move
 * out of memory for. At 1 the lock could not be contended by two stages at all and stayed for the
 * agent's own installs alone; at 3 it is load-bearing for the case it was written for, which is
 * what "exactly what is needed the moment this number moves" was anticipating.
 *
 * Card 0115 turns "edit this constant" into "write a `card-stage-concurrency` row" — this is now
 * the coded default at the bottom of `SettingsStore`'s resolution order, not the value in force.
 * See `CARD_STAGE_CONCURRENCY` (`settings/card.stage.concurrency.setting.ts`) for the setting
 * itself, and `BoundedCardStageJobRunner` (jobs.module.ts) for what makes a write actually reach
 * the running pg-boss worker.
 */
export const CARD_STAGE_CONCURRENCY_DEFAULT = 3;

/**
 * Floor for the `card-stage-concurrency` setting (card 0115): 1, not 0. Zero would mean this
 * daemon runs no stages at all — already expressible, more legibly, as `POLLER_ENABLED=false` for
 * the poller's own enqueueing — and would additionally block `POST .../start` (`wilson card
 * start`, `BoardWriteService.start`), which shares this same queue and worker and is out of this
 * card's scope to touch. A setting that can silently disable a different surface than the one an
 * operator meant to slow down is worse than no floor at all.
 */
export const CARD_STAGE_CONCURRENCY_MIN = 1;

/**
 * Ceiling for the `card-stage-concurrency` setting (card 0115): 8. Each unit of concurrency is a
 * git worktree, a `pnpm install`, and a live agent process on this host, per the disk/memory
 * headroom paragraph above — this bound exists to catch a fat-fingered value (an extra zero, say),
 * not to claim 8 is measured safe on any given host. "Raising it is a separate call from being
 * able to raise it" still holds exactly as written above; this only widens what is reachable
 * without a code change, never what is recommended.
 */
export const CARD_STAGE_CONCURRENCY_MAX = 8;

/**
 * How often the poller (`poller.ts`) checks the board for a card to enqueue.
 *
 * Every tick is a board read (`BoardRepository.list()`, all cards for the project) plus, when a
 * candidate exists, a `loadStages` and a `CardJobs.inFlight` check — cheap individually, but this
 * runs forever, so the interval is the floor on two costs at once: how often an idle daemon reads
 * the whole board for nothing, and how long a card sits ready after the dependency blocking it
 * merges before anything notices it. Thirty seconds is short enough that "the poller will pick it
 * up" is true on a timescale nobody waits on, and long enough that idle polling is noise next to
 * the database's normal load.
 *
 * Card 0115 turns this into a `poller-interval-ms` row rather than a constant a change requires a
 * deploy for — this is now the coded default at the bottom of `SettingsStore`'s resolution order.
 * `Poller.loop` reads the setting fresh every tick (`settings/poller.interval.setting.ts`), so a
 * write reaches a running daemon before its next tick, no restart involved — unlike
 * `CARD_STAGE_CONCURRENCY`, which pg-boss cannot reconfigure on a running worker at all.
 */
export const POLLER_INTERVAL_MS_DEFAULT = 30_000;

/**
 * Floor for the `poller-interval-ms` setting (card 0115): 5 seconds. Every tick is a full-board
 * read plus, when a candidate exists, a `loadStages` and a `CardJobs.inFlight` check — cheap once,
 * but this runs forever, so the floor exists to stop an operator from turning "poll more often"
 * into "hammer Postgres" with one fat-fingered value.
 */
export const POLLER_INTERVAL_MS_MIN = 5_000;

/**
 * Ceiling for the `poller-interval-ms` setting (card 0115): 5 minutes. Past that, "the poller will
 * pick it up" stops being a timescale nobody waits on — a card sitting ready for five minutes
 * after its blocking dependency merges is already a worse experience than running `wilson card
 * start` by hand.
 */
export const POLLER_INTERVAL_MS_MAX = 300_000;
