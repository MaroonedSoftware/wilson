import type { SettingDefinition } from './setting.definition.js';

/**
 * Whether the poller (`modules/jobs/poller.ts`) is enqueueing — this card's one setting.
 *
 * `POLLER_ENABLED` sets what a fresh database starts at, parsed identically to `configBoolean`
 * (`shared/require.config.ts`): only `"true"` or `"1"` enable it, everything else — including the
 * variable being unset — leaves it off. A `wilson.settings` row then overrides that without a
 * restart. See `SettingsStore.get` for the full precedence and `PollerSettingService` for what
 * makes a write take effect immediately.
 *
 * `scope: 'project'` (card 0152) — [[0149]] made this the interesting one: there is one poller loop
 * ticking every registered project in turn, which argues for deployment-wide the same way
 * `POLLER_INTERVAL_MS` is. But "pause this project without pausing the others" is a real thing an
 * operator wants — a project mid-incident, or one being decommissioned, without touching every
 * other project sharing the loop — and a per-project row is the only way to express that; a
 * deployment-wide row could only ever be all-on or all-off.
 */
export const POLLER_ENABLED: SettingDefinition<boolean> = {
    key: 'poller-enabled',
    scope: 'project',
    envVar: 'POLLER_ENABLED',
    parseEnv: raw => {
        const normalized = raw.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    },
    defaultValue: false,
};
