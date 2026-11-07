import type { SettingDefinition } from './setting.definition.js';

/**
 * **Deprecated as of card 0036. Nothing reads this setting.**
 *
 * It used to decide whether the poller had an agent draft the plan of a card waiting in `planning`
 * without one (`PlanDraftJob`), per project and off by default. Card 0036 made the whole pipeline
 * autopilot: the poller drafts every unplanned card, the runner approves a complete plan into
 * `backlog` (scope-check is the gate) and merges at `ready` behind the suite. With drafting
 * unconditional, this switch means nothing — `Poller` and `PlanDraftJob` no longer consult it, and the
 * web Settings toggle is gone. The only things that still bound drafting are the daily output-token
 * ceiling, drain, and the poller's own on/off switch.
 *
 * The key, `GET/PUT /api/settings/auto-plan`, its `settings.ck` operation (still `mcp: exclude`, so no
 * chat agent can reach it), the generated route/MCP files and the TypeScript, C# and Kotlin SDKs remain
 * only so existing clients keep working: they still persist a row that nothing reads. Retiring all of
 * those is deliberately deferred to a follow-up card — doing it here would have spread this card past
 * `scope-check`'s fan-out threshold.
 *
 * The definition itself is unchanged (parsing, `false` default, `scope: 'project'`) so those surfaces
 * keep answering exactly as before.
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
