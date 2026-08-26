import type { SettingDefinition } from './setting.definition.js';

/**
 * Whether the poller (`modules/jobs/poller.ts`) is enqueueing — this card's one setting.
 *
 * `POLLER_ENABLED` sets what a fresh database starts at, parsed identically to `configBoolean`
 * (`shared/require.config.ts`): only `"true"` or `"1"` enable it, everything else — including the
 * variable being unset — leaves it off. A `runner.settings` row then overrides that without a
 * restart. See `SettingsStore.get` for the full precedence and `PollerSettingService` for what
 * makes a write take effect immediately.
 */
export const POLLER_ENABLED: SettingDefinition<boolean> = {
    key: 'poller-enabled',
    envVar: 'POLLER_ENABLED',
    parseEnv: raw => {
        const normalized = raw.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    },
    defaultValue: false,
};
