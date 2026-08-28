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
 * board unattended, which costs money but reaches nothing outward. `NOTIFY_WEBHOOK_URL` used to stay
 * out of this table for exactly the opposite reason: unlike the poller switch, it reaches outward,
 * so exposing it the same way turns this unauthenticated surface into a general-purpose request
 * primitive — anything that can reach this port could make the daemon POST JSON of its choosing at
 * an address of its choosing.
 *
 * Card 0107 adds it anyway, below, but not the same way: `NotifyWebhookSettingService` runs
 * `checkWebhookDestination` (apps/api/src/modules/notify/webhook.destination.ts) against the write,
 * refusing anything that is not `https` or that resolves to a loopback, link-local (including the
 * cloud metadata address `169.254.169.254`), private, or unspecified address — and again on every
 * use, since a name that resolves safely at write can resolve unsafely later. Read that file's own
 * doc for exactly what this does and does not stop: in short, it narrows *where* this daemon can be
 * pointed, not *whether* an unauthenticated caller can point it somewhere the check still allows.
 * Authenticating this API (card 0019) is the actual answer; this is mitigation on top of its
 * absence, not a substitute for it.
 * generated from [PollerSetting](file://./../../../../apps/api/data/contracts/settings.ck#L41)
 */
export interface PollerSetting {
    enabled: boolean;
}

/**
 * generated from [SetPollerSettingRequest](file://./../../../../apps/api/data/contracts/settings.ck#L45)
 */
export interface SetPollerSettingRequest {
    enabled: boolean;
}

/**
 * Bounds enforced server-side by `PollerIntervalSettingService.set` (job.runner.config.ts carries
 * the numbers and the reasoning) — `curl` gets the same refusal the page does.
 * generated from [PollerInterval](file://./../../../../apps/api/data/contracts/settings.ck#L51)
 */
export interface PollerInterval {
    intervalMs: number;
}

/**
 * generated from [SetPollerIntervalRequest](file://./../../../../apps/api/data/contracts/settings.ck#L55)
 */
export interface SetPollerIntervalRequest {
    intervalMs: number;
}

/**
 * Bounds enforced server-side by `CardStageConcurrencySettingService.set` (job.runner.config.ts
 * carries the numbers and the reasoning) — `curl` gets the same refusal the page does.
 * generated from [CardStageConcurrency](file://./../../../../apps/api/data/contracts/settings.ck#L61)
 */
export interface CardStageConcurrency {
    concurrency: number;
}

/**
 * generated from [SetCardStageConcurrencyRequest](file://./../../../../apps/api/data/contracts/settings.ck#L65)
 */
export interface SetCardStageConcurrencyRequest {
    concurrency: number;
}

/**
 * `null` means unset — off, exactly like the environment variables these fields replace being
 * absent. One resource for both fields, not two: `Notifier.notify` always reads them together, and
 * a base URL with nothing to post it to is exactly as useless as a webhook with no way to name the
 * card in its payload (`board.config.ts`'s own comment on the pair).
 * generated from [NotifyWebhookSetting](file://./../../../../apps/api/data/contracts/settings.ck#L139)
 */
export interface NotifyWebhookSetting {
    webhookUrl: string | null;
    baseUrl: string | null;
}

/**
 * generated from [SetNotifyWebhookSettingRequest](file://./../../../../apps/api/data/contracts/settings.ck#L144)
 */
export interface SetNotifyWebhookSettingRequest {
    webhookUrl: string | null;
    baseUrl: string | null;
}

/**
 * `null` means unset — the engine falls back to whatever Claude Code credentials live in the
 * daemon user's own home directory, exactly as it does today (card 0141). Set, it points the `cli`
 * adapter's engine (`CliStageAgent`) and the planning session's engine (`PlanSessionAgent`) at this
 * directory instead via `CLAUDE_CONFIG_DIR` — see `subscriptionEnv` (cli.stage.agent.ts) for where
 * that environment variable is actually set.
 *
 * Only an absolute path is checked here, by `ClaudeConfigDirSettingService.set` — whether the
 * directory exists, is writable, or holds working credentials is deliberately not this card's
 * business (its Out of scope): a wrong-but-absolute value is discovered by every `cli`-adapter
 * stage failing at the model call, not by a check here guessing at what "working" means.
 * generated from [ClaudeConfigDirSetting](file://./../../../../apps/api/data/contracts/settings.ck#L184)
 */
export interface ClaudeConfigDirSetting {
    configDir: string | null;
}

/**
 * generated from [SetClaudeConfigDirSettingRequest](file://./../../../../apps/api/data/contracts/settings.ck#L188)
 */
export interface SetClaudeConfigDirSettingRequest {
    configDir: string | null;
}

/**
 * Card 0144. Whether `POST /api/cards/{id}/merge` rehearses onto the throwaway integration branch
 * instead of writing `main` — see `dry.run.setting.ts` for the default (on) and the precedence
 * (a `runner.settings` row overrides `DRY_RUN_ENABLED` overrides the coded default). Nothing here
 * is validated at write: unlike `claude-config-dir`, there is no shape a boolean can be wrong in.
 * generated from [DryRunSetting](file://./../../../../apps/api/data/contracts/settings.ck#L220)
 */
export interface DryRunSetting {
    enabled: boolean;
}

/**
 * generated from [SetDryRunSettingRequest](file://./../../../../apps/api/data/contracts/settings.ck#L224)
 */
export interface SetDryRunSettingRequest {
    enabled: boolean;
}
