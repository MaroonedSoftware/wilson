import { CARD_STAGE_CONCURRENCY_DEFAULT } from '#modules/jobs/job.runner.config.js';
import type { SettingDefinition } from './setting.definition.js';

/**
 * How many `card.stage` jobs this daemon runs at once — card 0115's third setting, and the one
 * `BoundedCardStageJobRunner` (jobs.module.ts) has to work hardest to apply safely: pg-boss fixes a
 * queue's worker concurrency at `pgboss.work()` time, so a write here cannot reach a running worker
 * the way a `POLLER_INTERVAL_MS` write reaches the next tick. See that class's doc for what a write
 * actually does instead.
 *
 * `CARD_STAGE_CONCURRENCY` was a hardcoded constant (`job.runner.config.ts`) until this card gave
 * it a database row — a fresh database and an unset environment still resolve to the exact 3 it
 * always has (`CARD_STAGE_CONCURRENCY_DEFAULT`).
 *
 * Parsed with the same fail-fast posture as `configNumber` (`shared/require.config.ts`): an
 * unparseable or non-integer environment value throws rather than silently falling back to the
 * default.
 */
export const CARD_STAGE_CONCURRENCY: SettingDefinition<number> = {
    key: 'card-stage-concurrency',
    envVar: 'CARD_STAGE_CONCURRENCY',
    parseEnv: raw => {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed)) {
            throw new Error(`Invalid CARD_STAGE_CONCURRENCY: "${raw}" is not an integer`);
        }
        return parsed;
    },
    defaultValue: CARD_STAGE_CONCURRENCY_DEFAULT,
};
