import type { SettingDefinition } from './setting.definition.js';

/**
 * Whether events wake this project's goals (PROJECT.md, Orchestration). `GoalWatcher` and `GoalWakeJob`
 * read it fresh every time, so turning it off stops the next wake-up with no restart.
 *
 * Off unless a project opts in: a wake-up is a model turn nobody asked for. `scope: 'project'`, like
 * `AUTO_SPLIT_ENABLED`, since how much of a board a person hands over is a property of that board.
 */
export const ORCHESTRATOR_ENABLED: SettingDefinition<boolean> = {
    key: 'orchestrator-enabled',
    scope: 'project',
    envVar: 'ORCHESTRATOR_ENABLED',
    parseEnv: raw => {
        const normalized = raw.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    },
    defaultValue: false,
};

/** The lowest ceiling {@link ORCHESTRATOR_DAILY_OUTPUT_TOKENS} takes. Below this, a turn or two pauses a goal for the day. */
export const ORCHESTRATOR_CEILING_MINIMUM = 1_000;

/**
 * How many output tokens a project's goal threads may spend in a day before wake-ups stop until
 * tomorrow. Apart from `DAILY_OUTPUT_TOKEN_CEILING`, which bounds stages: wake-ups draw on the same
 * engine accounts, and this is what stops them before they stop any stage.
 *
 * Unlike that setting, there is no "0 means no ceiling". Turns nobody asked for always have a bound, so
 * this has a default and a minimum (`OrchestratorSettingService.set`). A wake-up's answer is a few
 * thousand tokens at most, so the default allows dozens a day. A person's own messages on a goal's
 * thread count toward it and are never stopped by it.
 */
export const ORCHESTRATOR_DAILY_OUTPUT_TOKENS: SettingDefinition<number> = {
    key: 'orchestrator-daily-output-tokens',
    scope: 'project',
    envVar: 'ORCHESTRATOR_DAILY_OUTPUT_TOKENS',
    parseEnv: raw => {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < ORCHESTRATOR_CEILING_MINIMUM) {
            throw new Error(`Invalid ORCHESTRATOR_DAILY_OUTPUT_TOKENS: "${raw}" is not an integer of at least ${ORCHESTRATOR_CEILING_MINIMUM}`);
        }
        return parsed;
    },
    defaultValue: 100_000,
};
