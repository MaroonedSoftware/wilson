import type { SettingDefinition } from './setting.definition.js';

/**
 * Whether `StatusMirrorPoller` (`#modules/sources/status.mirror.poller.js`, card 0201) mirrors a
 * card's stage back to its `external` ref for one project — pausing outward mirroring is a
 * per-project decision, the same reasoning `SOURCE_POLL_ENABLED` (`source.poll.enabled.setting.ts`)
 * already gives for pausing inbound imports.
 *
 * Asked inside `StatusMirrorPoller.tickProject` itself, per project, on every tick — not gating
 * `start`/`stop` — `SourcePoller`'s own shape and reasoning for `SOURCE_POLL_ENABLED`: a project
 * registered while the daemon is running is picked up without a restart, and pausing one project's
 * mirroring must never stop another registered project's.
 *
 * `STATUS_MIRROR_ENABLED` sets what a fresh database starts at, parsed identically to
 * `SOURCE_POLL_ENABLED`: only `"true"` or `"1"` enable it, everything else — including the variable
 * being unset — leaves it off. Off by default: mirroring writes to a third party, potentially public,
 * surface, and an operator should opt into that rather than find it already on.
 */
export const STATUS_MIRROR_ENABLED: SettingDefinition<boolean> = {
    key: 'status-mirror-enabled',
    scope: 'project',
    envVar: 'STATUS_MIRROR_ENABLED',
    parseEnv: raw => {
        const normalized = raw.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    },
    defaultValue: false,
};
