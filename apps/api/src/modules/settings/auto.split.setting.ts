import type { SettingDefinition } from './setting.definition.js';

/**
 * Whether a scope-check refusal the verifier supported splits its card without asking.
 * `AutoSplitter` reads this fresh on every refusal, so persisting the row is the whole job, the same
 * posture `DRY_RUN_ENABLED` (`dry.run.setting.ts`) takes.
 *
 * Parsed identically to `POLLER_ENABLED`: only `"true"` or `"1"` count as on. `defaultValue` is
 * `false`: a split creates cards and retires the origin, so a project opts in. Left off, a refusal
 * goes back to `planning` and an operator confirms the division through `BoardWriteService.split`.
 *
 * `scope: 'project'`, matching `POLLER_ENABLED`: how much of a project's board an operator hands to
 * the runner is a property of that project, not of the machine running the daemon.
 */
export const AUTO_SPLIT_ENABLED: SettingDefinition<boolean> = {
    key: 'auto-split-enabled',
    scope: 'project',
    envVar: 'AUTO_SPLIT_ENABLED',
    parseEnv: raw => {
        const normalized = raw.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    },
    defaultValue: false,
};
