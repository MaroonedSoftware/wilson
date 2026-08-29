import type { SettingDefinition } from './setting.definition.js';

/**
 * Whether a merge rehearses onto the throwaway integration branch instead of writing `main` — card
 * 0144, wiring up the mechanism PROJECT.md's *Safety* section described from the start: "the
 * pipeline runs end to end, merges into a throwaway integration branch, and withholds only the
 * write to main, logging the intended merge instead. Ship with dry run on. Turn it off only after
 * supervising a full clean pass including a dependent card."
 *
 * `DRY_RUN_ENABLED` sets what a fresh database starts at, parsed identically to `POLLER_ENABLED`
 * (`poller.enabled.setting.ts`): only `"true"` or `"1"` count as an explicit env-var override,
 * everything else falls through. Unlike the poller, `defaultValue` here is `true` — the one place
 * PROJECT.md's "ship with dry run on" actually lives in code. A deployment that has supervised its
 * clean pass turns this off with a `runner.settings` row (`DryRunSettingService.set`), the same way
 * every other operational setting in this table is turned from its default — never by inverting the
 * default itself, which would ship every *other* deployment rehearsing nothing from its first merge.
 *
 * `scope: 'project'` (card 0152) — rehearsing merges is a property of how much an operator trusts
 * *one project's* pipeline, not of the machine running it: a project that has supervised its clean
 * pass and a freshly registered one sitting on the same daemon are exactly the case this setting
 * exists to tell apart, so a deployment-wide row would erase the distinction the moment a second
 * project showed up.
 */
export const DRY_RUN_ENABLED: SettingDefinition<boolean> = {
    key: 'dry-run-enabled',
    scope: 'project',
    envVar: 'DRY_RUN_ENABLED',
    parseEnv: raw => {
        const normalized = raw.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    },
    defaultValue: true,
};
