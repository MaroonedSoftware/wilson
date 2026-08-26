options {
    services: {
        PollerSettingService: "#modules/settings/poller.setting.service.js"
        PollerIntervalSettingService: "#modules/settings/poller.interval.setting.service.js"
        CardStageConcurrencySettingService: "#modules/settings/card.stage.concurrency.setting.service.js"
    }
    security: none
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
# `security: none` for the same reason board.ck and health.ck are: the API binds to 127.0.0.1
# (BoardConfig/server startup) and has no auth boundary yet (card 0019). Anything that can reach
# this port could already flip the poller on directly if it were a plain code change, so exposing
# it here is the same accepted risk restated as an HTTP call: worst case the runner works the
# board unattended, which costs money but reaches nothing outward. `NOTIFY_WEBHOOK_URL` is a
# different question, because it does reach outward, and stays out of this table for exactly that
# reason — card 0107.
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
