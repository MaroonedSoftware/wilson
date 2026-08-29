/**
 * Describes one operational setting, typed end to end.
 *
 * `SettingsStore.get`/`.set` (settings.store.ts) take one of these and need no schema change to
 * support it — a second setting (`POLLER_INTERVAL_MS` is the obvious one, `CARD_STAGE_CONCURRENCY`
 * a plausible third) is a new `SettingDefinition`, not a new column or a new method.
 */
export interface SettingDefinition<T> {
    /** The row's key, and the identity `SettingsStore` reads/writes by within whatever `scope` picks out. */
    readonly key: string;
    /**
     * Whether this setting is one project's policy or the whole deployment's.
     *
     * `'project'` keys the row by `BoardConfig.project`, the same as every setting did before this
     * field existed — a value written while one project is current is invisible from another.
     * `'deployment'` keys it by a fixed identity that does not vary with the current project, so the
     * same row answers `SettingsStore.get` no matter which project asked (`SettingsStore`'s own doc
     * comment names the reserved row). Card 0152: see each definition's own doc comment for why it
     * is one or the other — the six existing settings split three and three, and the split is not
     * the one a naive "who does this describe" guess would give (`card-stage-concurrency` and
     * `poller-enabled` land on opposite sides despite both looking like poller/job knobs).
     */
    readonly scope: 'project' | 'deployment';
    /** The environment variable this setting overrode before a database row could. */
    readonly envVar: string;
    /** Parses the raw environment string into `T`. Only called when no database row exists. */
    readonly parseEnv: (raw: string) => T;
    /** What this setting is when neither a row nor the environment variable says otherwise. */
    readonly defaultValue: T;
}
