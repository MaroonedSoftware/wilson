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
 * This constant names that inherited default rather than changing it, and is what `JobsModule`
 * logs at startup so the ceiling is visible without reading pg-boss's source. Each concurrent stage
 * is a git worktree, a `pnpm install`, and an agent, so raising this trades disk and memory headroom
 * for throughput — a call that needs measuring the host it runs on, not this card.
 */
export const CARD_STAGE_CONCURRENCY = 1;
