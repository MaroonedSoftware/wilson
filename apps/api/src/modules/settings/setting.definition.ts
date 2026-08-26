/**
 * Describes one operational setting, typed end to end.
 *
 * `SettingsStore.get`/`.set` (settings.store.ts) take one of these and need no schema change to
 * support it — a second setting (`POLLER_INTERVAL_MS` is the obvious one, `CARD_STAGE_CONCURRENCY`
 * a plausible third) is a new `SettingDefinition`, not a new column or a new method.
 */
export interface SettingDefinition<T> {
    /** The row's key within a project, and the identity `SettingsStore` reads/writes by. */
    readonly key: string;
    /** The environment variable this setting overrode before a database row could. */
    readonly envVar: string;
    /** Parses the raw environment string into `T`. Only called when no database row exists. */
    readonly parseEnv: (raw: string) => T;
    /** What this setting is when neither a row nor the environment variable says otherwise. */
    readonly defaultValue: T;
}
