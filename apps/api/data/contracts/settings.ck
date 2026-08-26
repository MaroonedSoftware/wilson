options {
    services: {
        PollerSettingService: "#modules/settings/poller.setting.service.js"
    }
    security: none
}

# Operational settings live in the database now (card 0106) — the poller is the first, and for
# now the only, one. No web UI yet — a later card, once this shape is settled; this exists so it
# is curl-able and the shape (database row overrides POLLER_ENABLED overrides off) is proven out.
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
