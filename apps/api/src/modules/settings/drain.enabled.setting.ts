import type { SettingDefinition } from './setting.definition.js';

/**
 * Whether the server is draining: running stages finish, and nothing new starts until it is turned
 * off again. This is what makes a restart safe, because a stage running at restart loses its agent
 * run and spends a retry, while a job held by `holdWhileDraining` just waits in Postgres.
 *
 * Auto-mode cannot do this. `poller-enabled` only stops the poller, and a stage that passes enqueues
 * its next stage directly, so a board with Auto-mode off still starts new stages.
 *
 * A row survives the restart on purpose: the new process must not start work until an operator says
 * so. `DRAIN_ENABLED` sets what a fresh database starts at, parsed identically to `POLLER_ENABLED`.
 *
 * `scope: 'deployment'`: a restart stops every project's stages at once, the same reasoning
 * `CARD_STAGE_CONCURRENCY` gives, so a per-project row could not express what this is for.
 */
export const DRAIN_ENABLED: SettingDefinition<boolean> = {
    key: 'drain-enabled',
    scope: 'deployment',
    envVar: 'DRAIN_ENABLED',
    parseEnv: raw => {
        const normalized = raw.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    },
    defaultValue: false,
};
