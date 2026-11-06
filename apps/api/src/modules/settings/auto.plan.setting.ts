import type { SettingDefinition } from './setting.definition.js';

/**
 * Whether the poller has an agent draft the plan of a card waiting in `planning` without one
 * (`PlanDraftJob`), so a person meets a plan to approve rather than a stub. Each draft is a model run,
 * once per card. Approval stays a person's: a drafted card still waits in `planning`.
 *
 * Parsed identically to `AUTO_SPLIT_ENABLED`: only `"true"` or `"1"` count as on. `defaultValue` is
 * `false`, because turning it on spends tokens on every unplanned card already on the board, so a
 * project opts in. Read fresh on every poller tick and again when the job runs, so persisting the row
 * is the whole job.
 *
 * `scope: 'project'`, matching `AUTO_SPLIT_ENABLED`: how much of a project's board an operator hands
 * to the runner is a property of that project.
 */
export const AUTO_PLAN_ENABLED: SettingDefinition<boolean> = {
    key: 'auto-plan-enabled',
    scope: 'project',
    envVar: 'AUTO_PLAN_ENABLED',
    parseEnv: raw => {
        const normalized = raw.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    },
    defaultValue: false,
};
