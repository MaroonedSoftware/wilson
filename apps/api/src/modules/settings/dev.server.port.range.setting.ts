import type { SettingDefinition } from './setting.definition.js';

/** The inclusive range `DEV_SERVER_PORT_RANGE` names, e.g. `4000-4100`. */
export interface DevServerPortRange {
    readonly start: number;
    readonly end: number;
}

const MIN_PORT = 1;
const MAX_PORT = 65535;

/** Parses `"START-END"`, failing fast the same way `CARD_STAGE_CONCURRENCY`'s `parseEnv` does. */
const parsePortRange = (raw: string): DevServerPortRange => {
    const match = /^(\d+)-(\d+)$/.exec(raw.trim());
    if (!match) {
        throw new Error(`Invalid DEV_SERVER_PORT_RANGE: "${raw}" is not "START-END" (e.g. "4000-4100")`);
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start < MIN_PORT || end > MAX_PORT || start > end) {
        throw new Error(`Invalid DEV_SERVER_PORT_RANGE: "${raw}" must satisfy ${MIN_PORT} <= start <= end <= ${MAX_PORT}`);
    }
    return { start, end };
};

/**
 * The port range a stage's dev server may be given, via `PORT` — card 0027, the first resource type
 * built on card 0165's lease mechanism (which deliberately shipped unused; see `LeaseService`'s own
 * doc comment). `DevServerPortAllocator` (`#modules/lease/dev.server.port.allocator.js`) walks this
 * range, one lease acquisition per candidate.
 *
 * Unset by default, and that is the point: with no range configured, `StageDispatcher` never calls
 * the allocator at all, so a deploy that never sets this behaves exactly as it did before this card —
 * no lease row, no `PORT`, nothing. The same shape card 0164 used for the same reason (a mechanism
 * that changes behaviour the moment it merges cannot be landed and observed separately).
 *
 * `scope: 'deployment'` — the same reasoning `CARD_STAGE_CONCURRENCY` gives, one level down: a TCP
 * port is a property of the *machine* this daemon runs on, not of any one project, which is exactly
 * why `wilson.leases.resource_key` (the migration's own comment) is a bare primary key rather than
 * `(project, resource_key)`. Keying this setting by project would let two projects each configure
 * their own range and still collide on the machine the moment the ranges overlapped — one range for
 * the deployment avoids that by construction.
 *
 * Not exposed over HTTP, in `settings.ck`, or on the web app's settings page (this card's own
 * Constraints) — `notify.base.url.setting.ts` is the precedent for a setting read straight from
 * `SettingsStore` with no service of its own.
 */
export const DEV_SERVER_PORT_RANGE: SettingDefinition<DevServerPortRange | undefined> = {
    key: 'dev-server-port-range',
    scope: 'deployment',
    envVar: 'DEV_SERVER_PORT_RANGE',
    parseEnv: parsePortRange,
    defaultValue: undefined,
};
