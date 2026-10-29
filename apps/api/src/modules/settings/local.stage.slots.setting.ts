import { LOCAL_STAGE_SLOTS_DEFAULT } from '#modules/jobs/job.runner.config.js';
import type { SettingDefinition } from './setting.definition.js';

/**
 * How many stages may hold a worktree on this machine at once, whatever `card-stage-concurrency`
 * allows overall. Once stages can run on registered hosts, the total and this machine's share stop
 * being the same number: twelve stages across three agent VMs is no reason to run twelve here when
 * the hosts are busy and a `placement: any` stage falls back to this machine.
 *
 * Enforced as `runner.leases` rows (`local:slot:N`), taken by `HostPlacer.takeLocalSlot` before a
 * stage's worktree is cut and released by the dispatcher when the stage ends. A stage that finds
 * every slot held is deferred, not failed, the way a `remote` stage with no host is.
 *
 * `scope: 'deployment'`, for the reason `card-stage-concurrency` gives: it describes this machine, not
 * a project.
 */
export const LOCAL_STAGE_SLOTS: SettingDefinition<number> = {
    key: 'local-stage-slots',
    scope: 'deployment',
    envVar: 'LOCAL_STAGE_SLOTS',
    parseEnv: raw => {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed)) {
            throw new Error(`Invalid LOCAL_STAGE_SLOTS: "${raw}" is not an integer`);
        }
        return parsed;
    },
    defaultValue: LOCAL_STAGE_SLOTS_DEFAULT,
};
