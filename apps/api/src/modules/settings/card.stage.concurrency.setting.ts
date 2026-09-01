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
 * it a database row — a fresh database and an unset environment still resolve to
 * `CARD_STAGE_CONCURRENCY_DEFAULT`, so this card changed no behaviour. What it preserved was the
 * value in force when it landed, which is not one the constant has always held: 3 dates only from
 * the raise on 2026-08-25, and it was 1 for most of the life before that. See the constant's own
 * doc for that history.
 *
 * Parsed with the same fail-fast posture as `configNumber` (`shared/require.config.ts`): an
 * unparseable or non-integer environment value throws rather than silently falling back to the
 * default.
 *
 * `scope: 'deployment'` (card 0152) — [[0149]] settled this: "there is exactly one `card.stage`
 * queue and one worker" (`jobs.module.ts`), and pg-boss fixes that queue's concurrency once, for
 * the whole process, at `pgboss.work()` time. A second registered project cannot get its own
 * budget no matter which project a row is keyed by, so keying it by the current project only
 * produces a row the concurrency reconciler never reads. One budget for the one worker, so one row
 * for the deployment.
 */
export const CARD_STAGE_CONCURRENCY: SettingDefinition<number> = {
    key: 'card-stage-concurrency',
    scope: 'deployment',
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
