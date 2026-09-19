import type { SettingDefinition } from './setting.definition.js';

/**
 * Whether `merge` sends a card back to `review` when `main` moved, since the card's review ran,
 * under files the card itself changed — card 0238. `BoardWriteService.merge` reads this fresh on
 * every attempt, the same posture `DRY_RUN_ENABLED` (`dry.run.setting.ts`) takes for a setting
 * nothing needs applied at write time: persisting the row is the whole job, so there is no
 * corresponding `*SettingService` to push a change into a running process.
 *
 * Parsed identically to `DRY_RUN_ENABLED`/`POLLER_ENABLED`: only `"true"` or `"1"` count as an
 * explicit env-var override. `defaultValue` is `true` — the re-review check ships on, the same
 * "ship the safety net on" posture PROJECT.md's *Safety* section already set for dry run.
 *
 * `scope: 'project'` (card 0152), matching `DRY_RUN_ENABLED`: how much an operator trusts a
 * project's reviewers to have seen the combined diff is a property of that project's pipeline, not
 * of the machine running the daemon.
 */
export const RE_REVIEW_ON_MERGE: SettingDefinition<boolean> = {
    key: 're-review-on-merge',
    scope: 'project',
    envVar: 'RE_REVIEW_ON_MERGE',
    parseEnv: raw => {
        const normalized = raw.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    },
    defaultValue: true,
};
