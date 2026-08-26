import { POLLER_INTERVAL_MS_DEFAULT } from '#modules/jobs/job.runner.config.js';
import type { SettingDefinition } from './setting.definition.js';

/**
 * How often the poller (`modules/jobs/poller.ts`) checks the board for a card to enqueue — card
 * 0115's second setting (see `POLLER_ENABLED`, `poller.enabled.setting.ts`, for the first).
 *
 * `POLLER_INTERVAL_MS` was a hardcoded constant (`job.runner.config.ts`) until this card gave it a
 * database row the same way 0106 gave `POLLER_ENABLED` one — a fresh database and an unset
 * environment still resolve to the exact 30 seconds it always has
 * (`POLLER_INTERVAL_MS_DEFAULT`). Unlike `CARD_STAGE_CONCURRENCY`, a write here needs nothing
 * pushed into a running process to take effect: `Poller.loop` calls `SettingsStore.get` on this
 * definition at the top of every iteration, so the very next tick uses whatever is current.
 *
 * Parsed with the same fail-fast posture as `configNumber` (`shared/require.config.ts`): an
 * unparseable environment value throws rather than silently falling back to the default, so a
 * typo'd `POLLER_INTERVAL_MS` is caught the moment it's read instead of producing a
 * plausible-but-wrong interval nobody notices.
 */
export const POLLER_INTERVAL_MS: SettingDefinition<number> = {
    key: 'poller-interval-ms',
    envVar: 'POLLER_INTERVAL_MS',
    parseEnv: raw => {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
            throw new Error(`Invalid POLLER_INTERVAL_MS: "${raw}" is not a number`);
        }
        return parsed;
    },
    defaultValue: POLLER_INTERVAL_MS_DEFAULT,
};
