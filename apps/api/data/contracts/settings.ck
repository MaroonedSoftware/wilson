options {
    services: {
        PollerSettingService: "#modules/settings/poller.setting.service.js"
        PollerIntervalSettingService: "#modules/settings/poller.interval.setting.service.js"
        CardStageConcurrencySettingService: "#modules/settings/card.stage.concurrency.setting.service.js"
        NotifyWebhookSettingService: "#modules/settings/notify.webhook.setting.service.js"
        ClaudeConfigDirSettingService: "#modules/settings/claude.config.dir.setting.service.js"
        DryRunSettingService: "#modules/settings/dry.run.setting.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# Operational settings live in the database now (card 0106) — the poller's on/off switch was the
# first. Card 0115 adds the two numeric ones an operator actually turns: how often the poller
# looks (`poller-interval-ms`) and how many stages run at once (`card-stage-concurrency`). All
# three share the same shape: a database row overrides the environment variable overrides a coded
# default (`SettingsStore.get`), and a write takes effect without a restart — for the interval,
# because `Poller.loop` reads it fresh every tick; for concurrency, see
# `BoundedCardStageJobRunner`'s doc (jobs.module.ts) for why that one restarts the (idle) worker
# instead of pretending pg-boss can reconfigure a running one in place.
#
# Gated (PROJECT.md decision 10): the file's floor is `wilson.manage`, which a signed-in session
# or a `manage` API key satisfies, and every `get` lowers it to `wilson.view`, which any session
# or key does. Anything without a credential gets 401 before a handler runs.
#
# `NOTIFY_WEBHOOK_URL` used to stay out of this table because, unlike the poller switch, it reaches
# outward: whoever can set it can make the daemon POST JSON of its choosing at an address of its
# choosing. Writing it needs `wilson.manage` now, so that is the operator.
#
# Card 0107 adds it anyway, below, but not the same way: `NotifyWebhookSettingService` runs
# `checkWebhookDestination` (apps/api/src/modules/notify/webhook.destination.ts) against the write,
# refusing anything that is not `https` or that resolves to a loopback, link-local (including the
# cloud metadata address `169.254.169.254`), private, or unspecified address — and again on every
# use, since a name that resolves safely at write can resolve unsafely later. Read that file's own
# doc for exactly what this does and does not stop: in short, it narrows *where* this daemon can be
# pointed. The check stays as defence in depth behind authentication: a leaked `manage` key should
# still not be able to aim the daemon at the cloud metadata address.
contract PollerSetting: {
    enabled: boolean
}

contract SetPollerSettingRequest: {
    enabled: boolean
}

# Bounds enforced server-side by `PollerIntervalSettingService.set` (job.runner.config.ts carries
# the numbers and the reasoning) — `curl` gets the same refusal the page does.
contract PollerInterval: {
    intervalMs: int
}

contract SetPollerIntervalRequest: {
    intervalMs: int
}

# Bounds enforced server-side by `CardStageConcurrencySettingService.set` (job.runner.config.ts
# carries the numbers and the reasoning) — `curl` gets the same refusal the page does.
contract CardStageConcurrency: {
    concurrency: int
}

contract SetCardStageConcurrencyRequest: {
    concurrency: int
}

operation /api/settings/poller-enabled: {
    get: {
        security: {
            policy: wilson.view
        }
        name: Get poller setting
        service: PollerSettingService.get
        response: {
            200: { application/json: PollerSetting }
        }
    }
    put: {
        name: Set poller setting
        service: PollerSettingService.set
        request: {
            application/json: SetPollerSettingRequest
        }
        response: {
            200: { application/json: PollerSetting }
        }
    }
}

operation /api/settings/poller-interval-ms: {
    get: {
        security: {
            policy: wilson.view
        }
        name: Get poller interval
        service: PollerIntervalSettingService.get
        response: {
            200: { application/json: PollerInterval }
        }
    }
    put: {
        name: Set poller interval
        service: PollerIntervalSettingService.set
        request: {
            application/json: SetPollerIntervalRequest
        }
        response: {
            200: { application/json: PollerInterval }
            # Outside [POLLER_INTERVAL_MS_MIN, POLLER_INTERVAL_MS_MAX] (job.runner.config.ts) —
            # carried via `details`, the same convention board.ck's mutations use.
            400:
        }
    }
}

operation /api/settings/card-stage-concurrency: {
    get: {
        security: {
            policy: wilson.view
        }
        name: Get card stage concurrency
        service: CardStageConcurrencySettingService.get
        response: {
            200: { application/json: CardStageConcurrency }
        }
    }
    put: {
        name: Set card stage concurrency
        service: CardStageConcurrencySettingService.set
        request: {
            application/json: SetCardStageConcurrencyRequest
        }
        response: {
            200: { application/json: CardStageConcurrency }
            # Outside [CARD_STAGE_CONCURRENCY_MIN, CARD_STAGE_CONCURRENCY_MAX] (job.runner.config.ts)
            # — carried via `details`, the same convention board.ck's mutations use.
            400:
        }
    }
}

# `null` means unset — off, exactly like the environment variables these fields replace being
# absent. One resource for both fields, not two: `Notifier.notify` always reads them together, and
# a base URL with nothing to post it to is exactly as useless as a webhook with no way to name the
# card in its payload (`board.config.ts`'s own comment on the pair).
contract NotifyWebhookSetting: {
    webhookUrl: string | null
    baseUrl: string | null
}

contract SetNotifyWebhookSettingRequest: {
    webhookUrl: string | null
    baseUrl: string | null
}

operation /api/settings/notify-webhook: {
    get: {
        security: {
            policy: wilson.view
        }
        name: Get notify webhook setting
        service: NotifyWebhookSettingService.get
        response: {
            200: { application/json: NotifyWebhookSetting }
        }
    }
    put: {
        name: Set notify webhook setting
        service: NotifyWebhookSettingService.set
        request: {
            application/json: SetNotifyWebhookSettingRequest
        }
        response: {
            200: { application/json: NotifyWebhookSetting }
            # webhookUrl is not https, or resolves to a loopback/link-local/private/unspecified
            # address (`checkWebhookDestination`'s own reason string) — carried via `details`, the
            # same convention every other refusal on this contract uses. baseUrl is never refused;
            # it is a link in a payload, not a destination (card 0107's Out of scope).
            400:
        }
    }
}

# `null` means unset — the engine falls back to whatever Claude Code credentials live in the
# daemon user's own home directory, exactly as it does today (card 0141). Set, it points the `cli`
# adapter's engine (`CliStageAgent`) and the planning session's engine (`PlanSessionAgent`) at this
# directory instead via `CLAUDE_CONFIG_DIR` — see `subscriptionEnv` (cli.stage.agent.ts) for where
# that environment variable is actually set.
#
# Only an absolute path is checked here, by `ClaudeConfigDirSettingService.set` — whether the
# directory exists, is writable, or holds working credentials is deliberately not this card's
# business (its Out of scope): a wrong-but-absolute value is discovered by every `cli`-adapter
# stage failing at the model call, not by a check here guessing at what "working" means.
contract ClaudeConfigDirSetting: {
    configDir: string | null
}

contract SetClaudeConfigDirSettingRequest: {
    configDir: string | null
}

operation /api/settings/claude-config-dir: {
    get: {
        security: {
            policy: wilson.view
        }
        name: Get claude config dir setting
        service: ClaudeConfigDirSettingService.get
        response: {
            200: { application/json: ClaudeConfigDirSetting }
        }
    }
    put: {
        name: Set claude config dir setting
        service: ClaudeConfigDirSettingService.set
        request: {
            application/json: SetClaudeConfigDirSettingRequest
        }
        response: {
            200: { application/json: ClaudeConfigDirSetting }
            # configDir is not an absolute path (`ClaudeConfigDirSettingService.set`'s own reason
            # string) — carried via `details`, the same convention every other refusal on this
            # contract uses.
            400:
        }
    }
}

# Card 0144. Whether `POST /api/cards/{id}/merge` rehearses onto the throwaway integration branch
# instead of writing `main` — see `dry.run.setting.ts` for the default (on) and the precedence
# (a `runner.settings` row overrides `DRY_RUN_ENABLED` overrides the coded default). Nothing here
# is validated at write: unlike `claude-config-dir`, there is no shape a boolean can be wrong in.
contract DryRunSetting: {
    enabled: boolean
}

contract SetDryRunSettingRequest: {
    enabled: boolean
}

operation /api/settings/dry-run: {
    get: {
        security: {
            policy: wilson.view
        }
        name: Get dry run setting
        service: DryRunSettingService.get
        response: {
            200: { application/json: DryRunSetting }
        }
    }
    put: {
        name: Set dry run setting
        service: DryRunSettingService.set
        request: {
            application/json: SetDryRunSettingRequest
        }
        response: {
            200: { application/json: DryRunSetting }
        }
    }
}
