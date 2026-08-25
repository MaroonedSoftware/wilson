/**
 * How many `card.stage` jobs may run at once, on this daemon process.
 *
 * pg-boss's own `PgBoss#work(name, handler, options?)` takes `WorkConcurrencyOptions`:
 * `localConcurrency` (how many workers it spawns per node to poll and process a queue) and
 * `batchSize` (how many jobs one poll fetches). Both default to `1` when the option is omitted
 * (pg-boss `manager.js`, `Manager#work`: `localConcurrency = 1, batchSize = 1`), and each spawned
 * worker's loop `await`s a fetched job to finish before fetching again (pg-boss `worker.js`,
 * `Worker#run`). So an unconfigured queue processes exactly one job at a time.
 *
 * `@maroonedsoftware/jobbroker`'s `PgBossJobRunner.start()` — what `JobsModule` wires up as
 * `JobRunner` below — calls `pgboss.work(name, handler)` with no options object for every
 * registered queue, `card.stage` included. jobbroker 1.11.5 has no hook for `WorkOptions`
 * anywhere: `PgBossJobRegistration` carries only `job`, `cron` and `policy`, and `policy` (see
 * `CARD_STAGE_POLICY`) maps to queue *creation* options — retry limits, backoff, dead-letter — not
 * to work-time concurrency, and `PgBossJobRunner` exposes no concurrency property alongside its
 * `cancelPollIntervalSeconds` and `defaultQueuePolicy`. So the one-at-a-time default above is not a
 * setting anyone chose for `card.stage`; it is what pg-boss falls back to because nothing in this
 * stack can override it short of bypassing `PgBossJobRunner` or jobbroker growing a `WorkOptions`
 * hook — neither of which this card does.
 *
 * The value is 2, measured rather than read: a sweep over `stage.dispatched`/`stage.passed` pairs
 * in `runner.card_events` puts the maximum at two simultaneous stages (0053 and 0054 both in
 * `implementing` at 23:40:29 on 2026-08-24, and 0058/0059 the same at 23:59). Card 0063 originally
 * recorded 1 from reading pg-boss's documented default, which the runner's own history contradicts —
 * so whatever produces the second slot is not the documented default, and the reasoning above about
 * *why* nothing here can configure it stands while the number it inferred did not.
 *
 * This constant names that inherited default rather than changing it, and is what `JobsModule`
 * logs at startup so the ceiling is visible without reading pg-boss's source. Each concurrent stage
 * is a git worktree, a `pnpm install`, and an agent, so raising this trades disk and memory headroom
 * for throughput — a call that needs measuring the host it runs on, not this card.
 */
export const CARD_STAGE_CONCURRENCY = 2;

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
