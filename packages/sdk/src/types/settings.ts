/**
 * Operational settings live in the database now (card 0106) — the poller's on/off switch was the
 * first. Card 0115 adds the two numeric ones an operator actually turns: how often the poller
 * looks (`poller-interval-ms`) and how many stages run at once (`card-stage-concurrency`). All
 * three share the same shape: a database row overrides the environment variable overrides a coded
 * default (`SettingsStore.get`), and a write takes effect without a restart — for the interval,
 * because `Poller.loop` reads it fresh every tick; for concurrency, see
 * `BoundedCardStageJobRunner`'s doc (jobs.module.ts) for why that one restarts the (idle) worker
 * instead of pretending pg-boss can reconfigure a running one in place.
 *
 * `security: none` for the same reason board.ck and health.ck are: the API binds to 127.0.0.1
 * (BoardConfig/server startup) and has no auth boundary yet (card 0019). Anything that can reach
 * this port could already flip the poller on directly if it were a plain code change, so exposing
 * it here is the same accepted risk restated as an HTTP call: worst case the runner works the
 * board unattended, which costs money but reaches nothing outward. `NOTIFY_WEBHOOK_URL` is a
 * different question, because it does reach outward, and stays out of this table for exactly that
 * reason — card 0107.
 * generated from [PollerSetting](file://./../../../../apps/api/data/contracts/settings.ck#L26)
 */
export interface PollerSetting {
    enabled: boolean;
}

/**
 * generated from [SetPollerSettingRequest](file://./../../../../apps/api/data/contracts/settings.ck#L30)
 */
export interface SetPollerSettingRequest {
    enabled: boolean;
}

/**
 * Bounds enforced server-side by `PollerIntervalSettingService.set` (job.runner.config.ts carries
 * the numbers and the reasoning) — `curl` gets the same refusal the page does.
 * generated from [PollerInterval](file://./../../../../apps/api/data/contracts/settings.ck#L36)
 */
export interface PollerInterval {
    intervalMs: number;
}

/**
 * generated from [SetPollerIntervalRequest](file://./../../../../apps/api/data/contracts/settings.ck#L40)
 */
export interface SetPollerIntervalRequest {
    intervalMs: number;
}

/**
 * Bounds enforced server-side by `CardStageConcurrencySettingService.set` (job.runner.config.ts
 * carries the numbers and the reasoning) — `curl` gets the same refusal the page does.
 * generated from [CardStageConcurrency](file://./../../../../apps/api/data/contracts/settings.ck#L46)
 */
export interface CardStageConcurrency {
    concurrency: number;
}

/**
 * generated from [SetCardStageConcurrencyRequest](file://./../../../../apps/api/data/contracts/settings.ck#L50)
 */
export interface SetCardStageConcurrencyRequest {
    concurrency: number;
}
