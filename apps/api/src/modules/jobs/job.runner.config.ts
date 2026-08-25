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
 * That default is where the value 1 came from and it is deliberately kept: making the number
 * settable does not answer what it should be.
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
 * throughput — that needs measuring the host it runs on. What changed is only that the measurement
 * now has somewhere to land: edit this constant and the worker honours it.
 *
 * "On this daemon process" is also why `run.command.ts`'s `pnpmStoreLock` (card 0081, guarding
 * concurrent `pnpm install`s against pnpm's shared store) is a plain in-process lock rather than a
 * lockfile or a DB advisory lock: `concurrency` is pg-boss's *local* worker count, so every stage
 * this constant bounds is a job handler in the same event loop, and a lock that only needs to work
 * within one process is exactly as strong a guarantee as the concurrency this constant admits.
 * Raising this number stays bounded to one process too — a second daemon consuming the same queue
 * gets its own workers and its own copy of that lock, which is the case the lock would need to move
 * out of memory for. At 1 the lock cannot be contended by two stages at all; it stays because it
 * also covers the agent's own installs, and because it is exactly what is needed the moment this
 * number moves.
 */
export const CARD_STAGE_CONCURRENCY = 1;

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
 * Not a config value: like `CARD_STAGE_CONCURRENCY`, this is a call about the daemon's own
 * steady-state cost rather than something a deployment should need to tune, so it stays a constant
 * beside it rather than growing an env var of its own. Whether the poller runs at all is the actual
 * per-deployment choice — see `POLLER_ENABLED` in `jobs.module.ts`.
 */
export const POLLER_INTERVAL_MS = 30_000;
