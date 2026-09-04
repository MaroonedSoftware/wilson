import type { SettingDefinition } from './setting.definition.js';

/**
 * How often `StatusMirrorPoller` (`#modules/sources/status.mirror.poller.js`, card 0201) walks new
 * `transition.written` events for cards carrying an `external` ref. Tighter than
 * `SOURCE_POLL_INTERVAL_MS_DEFAULT` (`source.poll.interval.setting.ts`)'s five minutes: this loop is
 * driven by events that already happened in this database, not a blind fetch against GitHub's API, so
 * a shorter default costs nothing extra upstream.
 *
 * Declared here rather than in `job.runner.config.ts`, the same reason `SOURCE_POLL_INTERVAL_MS`
 * gives: `modules/jobs/` is `Poller`'s file to shape this after, never a file this card edits.
 */
export const STATUS_MIRROR_INTERVAL_MS_DEFAULT = 60_000;

/**
 * `STATUS_MIRROR_INTERVAL_MS` — one row for the whole deployment, not one per project.
 * `SOURCE_POLL_INTERVAL_MS`'s own reasoning: `StatusMirrorPoller` is one loop, `loop()` re-reads this
 * once per iteration and then walks every registered project with that single interval, so a
 * per-project row would only ever mean "the interval as of whichever project happened to be current
 * when someone last wrote it" — there is no second loop for a second project's row to govern.
 *
 * Parsed with the same fail-fast posture as `SOURCE_POLL_INTERVAL_MS`: an unparseable environment
 * value throws rather than silently falling back to the default.
 */
export const STATUS_MIRROR_INTERVAL_MS: SettingDefinition<number> = {
    key: 'status-mirror-interval-ms',
    scope: 'deployment',
    envVar: 'STATUS_MIRROR_INTERVAL_MS',
    parseEnv: raw => {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
            throw new Error(`Invalid STATUS_MIRROR_INTERVAL_MS: "${raw}" is not a number`);
        }
        return parsed;
    },
    defaultValue: STATUS_MIRROR_INTERVAL_MS_DEFAULT,
};
