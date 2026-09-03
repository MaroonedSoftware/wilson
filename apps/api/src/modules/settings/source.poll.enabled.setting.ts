import type { SettingDefinition } from './setting.definition.js';

/**
 * Whether `SourcePoller` (`#modules/sources/source.poller.js`, card 0198) imports for one project —
 * pausing imports is a per-project decision, the same reasoning `POLLER_ENABLED`
 * (`poller.enabled.setting.ts`) already gives for pausing the card poller.
 *
 * Unlike `POLLER_ENABLED`, nothing gates the loop's `start`/`stop` on this: `SourcePoller` always
 * ticks once started (`SourcesModule`'s `start`/`shutdown` hooks call `start()`/`stop()`
 * unconditionally), and `tickProject` asks this setting itself, per project, on every tick — so a
 * project registered while the daemon is running is picked up without a restart, and a per-project
 * pause never has to stop every other project's imports to take effect.
 *
 * `SOURCE_POLL_ENABLED` sets what a fresh database starts at, parsed identically to `POLLER_ENABLED`:
 * only `"true"` or `"1"` enable it, everything else — including the variable being unset — leaves it
 * off. Off by default: this is the first tick of a wholly new transport (PROJECT.md's "Card sources"),
 * and nothing registers a `CardSource` yet ([[0199]]), so there is nothing to import even were it on.
 */
export const SOURCE_POLL_ENABLED: SettingDefinition<boolean> = {
    key: 'source-poll-enabled',
    scope: 'project',
    envVar: 'SOURCE_POLL_ENABLED',
    parseEnv: raw => {
        const normalized = raw.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    },
    defaultValue: false,
};
