import type { SettingDefinition } from './setting.definition.js';

/**
 * How often `SourcePoller` (`#modules/sources/source.poller.js`, card 0198) asks every registered
 * `CardSource` what changed. Well above `POLLER_INTERVAL_MS_DEFAULT`'s 30 seconds
 * (`#modules/jobs/job.runner.config.js`) — a ticket system is not a queue, and every tick is a full
 * board read (`InboundCardWriter`'s ref lookup) per source per project on top of whatever the source
 * itself charges for a fetch, so polling at the card poller's cadence would be needless load for a
 * signal that does not need to land within seconds.
 *
 * Declared here rather than in `job.runner.config.ts`: this card's Constraints say `modules/jobs/` is
 * `Poller`'s file to shape this after, never a file this card edits.
 */
export const SOURCE_POLL_INTERVAL_MS_DEFAULT = 300_000;

/**
 * `SOURCE_POLL_INTERVAL_MS` — one row for the whole deployment, not one per project. Follows
 * `POLLER_INTERVAL_MS`'s own reasoning (`poller.interval.setting.ts`): `SourcePoller` is one loop,
 * `loop()` re-reads this once per iteration and then walks every registered project with that single
 * interval, so a per-project row would only ever mean "the interval as of whichever project happened
 * to be current when someone last wrote it" — there is no second loop for a second project's row to
 * govern.
 *
 * Parsed with the same fail-fast posture as `POLLER_INTERVAL_MS`: an unparseable environment value
 * throws rather than silently falling back to the default.
 */
export const SOURCE_POLL_INTERVAL_MS: SettingDefinition<number> = {
    key: 'source-poll-interval-ms',
    scope: 'deployment',
    envVar: 'SOURCE_POLL_INTERVAL_MS',
    parseEnv: raw => {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
            throw new Error(`Invalid SOURCE_POLL_INTERVAL_MS: "${raw}" is not a number`);
        }
        return parsed;
    },
    defaultValue: SOURCE_POLL_INTERVAL_MS_DEFAULT,
};
