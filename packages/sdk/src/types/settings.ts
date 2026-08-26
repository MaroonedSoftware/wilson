/**
 * Operational settings live in the database now (card 0106) — the poller is the first, and for
 * now the only, one. No web UI yet — a later card, once this shape is settled; this exists so it
 * is curl-able and the shape (database row overrides POLLER_ENABLED overrides off) is proven out.
 *
 * `security: none` for the same reason board.ck and health.ck are: the API binds to 127.0.0.1
 * (BoardConfig/server startup) and has no auth boundary yet (card 0019). Anything that can reach
 * this port could already flip the poller on directly if it were a plain code change, so exposing
 * it here is the same accepted risk restated as an HTTP call: worst case the runner works the
 * board unattended, which costs money but reaches nothing outward. `NOTIFY_WEBHOOK_URL` is a
 * different question, because it does reach outward, and stays out of this table for exactly that
 * reason — card 0107.
 * generated from [PollerSetting](file://./../../../../apps/api/data/contracts/settings.ck#L19)
 */
export interface PollerSetting {
    enabled: boolean;
}

/**
 * generated from [SetPollerSettingRequest](file://./../../../../apps/api/data/contracts/settings.ck#L23)
 */
export interface SetPollerSettingRequest {
    enabled: boolean;
}
