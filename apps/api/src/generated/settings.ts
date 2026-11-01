import { z } from 'zod';

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
 * Gated (PROJECT.md decision 10): the file's floor is `wilson.manage`, which a signed-in session
 * or a `manage` API key satisfies, and every `get` lowers it to `wilson.view`, which any session
 * or key does. Anything without a credential gets 401 before a handler runs.
 *
 * `NOTIFY_WEBHOOK_URL` used to stay out of this table because, unlike the poller switch, it reaches
 * outward: whoever can set it can make the daemon POST JSON of its choosing at an address of its
 * choosing. Writing it needs `wilson.manage` now, so that is the operator.
 *
 * Card 0107 adds it anyway, below, but not the same way: `NotifyWebhookSettingService` runs
 * `checkWebhookDestination` (apps/api/src/modules/notify/webhook.destination.ts) against the write,
 * refusing anything that is not `https` or that resolves to a loopback, link-local (including the
 * cloud metadata address `169.254.169.254`), private, or unspecified address — and again on every
 * use, since a name that resolves safely at write can resolve unsafely later. Read that file's own
 * doc for exactly what this does and does not stop: in short, it narrows *where* this daemon can be
 * pointed. The check stays as defence in depth behind authentication: a leaked `manage` key should
 * still not be able to aim the daemon at the cloud metadata address.
 * generated from [PollerSetting](../../data/contracts/settings.ck)
 */
export const PollerSetting = z.strictObject({
    enabled: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type PollerSetting = z.infer<typeof PollerSetting>;

/**
 * generated from [SetPollerSettingRequest](../../data/contracts/settings.ck)
 */
export const SetPollerSettingRequest = z.strictObject({
    enabled: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type SetPollerSettingRequest = z.infer<typeof SetPollerSettingRequest>;

/**
 * One card this process is running a stage for right now.
 * generated from [DrainRunningCard](../../data/contracts/settings.ck)
 */
export const DrainRunningCard = z.strictObject({
    project: z.string(),
    cardId: z.string(),
});
export type DrainRunningCard = z.infer<typeof DrainRunningCard>;

/**
 * generated from [SetDrainRequest](../../data/contracts/settings.ck)
 */
export const SetDrainRequest = z.strictObject({
    draining: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type SetDrainRequest = z.infer<typeof SetDrainRequest>;

/**
 * Bounds enforced server-side by `PollerIntervalSettingService.set` (job.runner.config.ts carries
 * the numbers and the reasoning) — `curl` gets the same refusal the page does.
 * generated from [PollerInterval](../../data/contracts/settings.ck)
 */
export const PollerInterval = z.strictObject({
    intervalMs: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
});
export type PollerInterval = z.infer<typeof PollerInterval>;

/**
 * generated from [SetPollerIntervalRequest](../../data/contracts/settings.ck)
 */
export const SetPollerIntervalRequest = z.strictObject({
    intervalMs: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
});
export type SetPollerIntervalRequest = z.infer<typeof SetPollerIntervalRequest>;

/**
 * Bounds enforced server-side by `CardStageConcurrencySettingService.set` (job.runner.config.ts
 * carries the numbers and the reasoning) — `curl` gets the same refusal the page does.
 * generated from [CardStageConcurrency](../../data/contracts/settings.ck)
 */
export const CardStageConcurrency = z.strictObject({
    concurrency: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
});
export type CardStageConcurrency = z.infer<typeof CardStageConcurrency>;

/**
 * generated from [SetCardStageConcurrencyRequest](../../data/contracts/settings.ck)
 */
export const SetCardStageConcurrencyRequest = z.strictObject({
    concurrency: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
});
export type SetCardStageConcurrencyRequest = z.infer<typeof SetCardStageConcurrencyRequest>;

/**
 * How many stages may hold a worktree on this machine at once, out of `card-stage-concurrency`'s
 * total across every machine. Bounds enforced by `LocalStageSlotsSettingService.set`.
 * generated from [LocalStageSlots](../../data/contracts/settings.ck)
 */
export const LocalStageSlots = z.strictObject({
    slots: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
});
export type LocalStageSlots = z.infer<typeof LocalStageSlots>;

/**
 * generated from [SetLocalStageSlotsRequest](../../data/contracts/settings.ck)
 */
export const SetLocalStageSlotsRequest = z.strictObject({
    slots: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
});
export type SetLocalStageSlotsRequest = z.infer<typeof SetLocalStageSlotsRequest>;

/**
 * `null` means unset — off, exactly like the environment variables these fields replace being
 * absent. One resource for both fields, not two: `Notifier.notify` always reads them together, and
 * a base URL with nothing to post it to is exactly as useless as a webhook with no way to name the
 * card in its payload (`board.config.ts`'s own comment on the pair).
 * generated from [NotifyWebhookSetting](../../data/contracts/settings.ck)
 */
export const NotifyWebhookSetting = z.strictObject({
    webhookUrl: z.string().nullable(),
    baseUrl: z.string().nullable(),
});
export type NotifyWebhookSetting = z.infer<typeof NotifyWebhookSetting>;

/**
 * generated from [SetNotifyWebhookSettingRequest](../../data/contracts/settings.ck)
 */
export const SetNotifyWebhookSettingRequest = z.strictObject({
    webhookUrl: z.string().nullable(),
    baseUrl: z.string().nullable(),
});
export type SetNotifyWebhookSettingRequest = z.infer<typeof SetNotifyWebhookSettingRequest>;

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
 * generated from [ClaudeConfigDirSetting](../../data/contracts/settings.ck)
 */
export const ClaudeConfigDirSetting = z.strictObject({
    configDir: z.string().nullable(),
});
export type ClaudeConfigDirSetting = z.infer<typeof ClaudeConfigDirSetting>;

/**
 * generated from [SetClaudeConfigDirSettingRequest](../../data/contracts/settings.ck)
 */
export const SetClaudeConfigDirSettingRequest = z.strictObject({
    configDir: z.string().nullable(),
});
export type SetClaudeConfigDirSettingRequest = z.infer<typeof SetClaudeConfigDirSettingRequest>;

/**
 * The token engines on this machine sign in with, saved encrypted so that changing it needs no
 * restart (`EngineTokenSettingService`). Write-only: nothing here ever returns it, only where the
 * current sign-in comes from. `none` leaves the engine to the login under its config directory.
 * generated from [EngineTokenSetting](../../data/contracts/settings.ck)
 */
export const EngineTokenSetting = z.strictObject({
    source: z.enum(['database', 'environment', 'none']),
});
export type EngineTokenSetting = z.infer<typeof EngineTokenSetting>;

/**
 * `null` removes the saved token.
 * generated from [SetEngineTokenSettingRequest](../../data/contracts/settings.ck)
 */
export const SetEngineTokenSettingRequest = z.strictObject({
    token: z.string().nullable(),
});
export type SetEngineTokenSettingRequest = z.infer<typeof SetEngineTokenSettingRequest>;

/**
 * Card 0144. Whether `POST /api/cards/{id}/merge` rehearses onto the throwaway integration branch
 * instead of writing `main` — see `dry.run.setting.ts` for the default (on) and the precedence
 * (a `wilson.settings` row overrides `DRY_RUN_ENABLED` overrides the coded default). Nothing here
 * is validated at write: unlike `claude-config-dir`, there is no shape a boolean can be wrong in.
 * generated from [DryRunSetting](../../data/contracts/settings.ck)
 */
export const DryRunSetting = z.strictObject({
    enabled: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type DryRunSetting = z.infer<typeof DryRunSetting>;

/**
 * generated from [SetDryRunSettingRequest](../../data/contracts/settings.ck)
 */
export const SetDryRunSettingRequest = z.strictObject({
    enabled: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type SetDryRunSettingRequest = z.infer<typeof SetDryRunSettingRequest>;

/**
 * Whether a scope-check refusal the verifier supported splits its card without an operator confirming
 * the division — see `auto.split.setting.ts` for the default (off) and `AutoSplitter` for what it does.
 * generated from [AutoSplitSetting](../../data/contracts/settings.ck)
 */
export const AutoSplitSetting = z.strictObject({
    enabled: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type AutoSplitSetting = z.infer<typeof AutoSplitSetting>;

/**
 * generated from [SetAutoSplitSettingRequest](../../data/contracts/settings.ck)
 */
export const SetAutoSplitSettingRequest = z.strictObject({
    enabled: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type SetAutoSplitSettingRequest = z.infer<typeof SetAutoSplitSettingRequest>;

/**
 * Which engine new chat threads start on ('cli', the Claude Agent SDK on the operator's subscription,
 * or 'api', the AI SDK against `provider`'s API key), and the model turns run on — see
 * `chat.engine.setting.ts` for the default and why a thread keeps the engine it started on.
 * generated from [ChatEngineSetting](../../data/contracts/settings.ck)
 */
export const ChatEngineSetting = z.strictObject({
    engine: z.enum(['api', 'cli']),
    provider: z.enum(['anthropic', 'openai', 'xai']),
    model: z.string(),
});
export type ChatEngineSetting = z.infer<typeof ChatEngineSetting>;

/**
 * The GitHub App this deployment acts as (`GitHubApp`). `keyInstalled` is read-only: the private key
 * goes in `GITHUB_APP_PRIVATE_KEY_FILE` on the daemon's machine and never passes through this API.
 * generated from [GitHubAppSetting](../../data/contracts/settings.ck)
 */
export const GitHubAppSetting = z.strictObject({
    appId: z.string().nullable(),
    keyInstalled: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type GitHubAppSetting = z.infer<typeof GitHubAppSetting>;

/**
 * generated from [SetGitHubAppSettingRequest](../../data/contracts/settings.ck)
 */
export const SetGitHubAppSettingRequest = z.strictObject({
    appId: z.string().nullable(),
});
export type SetGitHubAppSettingRequest = z.infer<typeof SetGitHubAppSettingRequest>;

/**
 * Whether the server is draining, and what a restart would interrupt. `safeToRestart` is true only
 * while draining with nothing running, since an idle moment without a drain lasts only until the next
 * stage starts. `held` counts every `card.stage` job waiting to run. `planDrafts` counts running plan
 * drafts, which a drain does not hold but a restart would still kill. Neither this nor `running` sees
 * a merge in progress, because a merge runs inside a request and not as a job.
 * generated from [DrainStatus](../../data/contracts/settings.ck)
 */
export const DrainStatus = z.strictObject({
    draining: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    running: z.array(DrainRunningCard),
    held: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    planDrafts: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    safeToRestart: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type DrainStatus = z.infer<typeof DrainStatus>;
