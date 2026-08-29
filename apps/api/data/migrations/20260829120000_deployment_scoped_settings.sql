-- migrate:up

-- =========================================================================
-- Card 0152: `claude-config-dir`, `card-stage-concurrency` and
-- `poller-interval-ms` become deployment-scoped settings
-- (`SettingDefinition.scope`, apps/api/src/modules/settings/setting.definition.ts)
-- instead of per-project ones — see those three definitions' own doc
-- comments for why. `SettingsStore` (settings.store.ts) now keys a
-- deployment-scoped row by the reserved `project` value `'__deployment__'`
-- (its own `DEPLOYMENT_SCOPE` constant) instead of `BoardConfig.project`,
-- so the same row answers no matter which project is current.
--
-- An operator who already set one of these three wrote its row under
-- whichever project was current at the time — carry that value forward
-- under the reserved key rather than losing it, exactly the way it already
-- reads back for the single project this deployment has today (this card's
-- "single-project case must not change" acceptance criterion).
--
-- This lists the *project*-scoped keys and moves every other row, rather
-- than listing the deployment-scoped keys and moving only those. An
-- earlier version of this migration did the latter, named two of the three
-- deployment-scoped keys in its WHERE clause and its own comment, and
-- silently left a pre-existing `poller-interval-ms` row stranded under its
-- old project key while `SettingsStore` had already started reading the
-- reserved deployment key for it — the operator's configured interval
-- silently replaced by the environment value or the coded default. A key
-- missing from the *project*-scoped exclusion list below defaults to being
-- carried across as deployment-scoped, the same side `SettingDefinition.scope`
-- already puts it on, so a newly deployment-scoped setting needs nothing
-- added here at all; a newly project-scoped one that is missing here would
-- instead be wrongly moved, which setting.scope.classification.test.ts and
-- settings.store.test.ts exist to catch by checking the resolved value, not
-- the migration's SQL text.
--
-- A second registered project having *also* written one of these keys is
-- not possible yet — registering a second project is out of scope for this
-- card and the one before it ([[0149]]) — but the migration does not
-- assume that away: if it ever finds more than one row for the same key,
-- it keeps only the most recently updated one and drops the rest, the same
-- "last write wins" a single `SettingsStore.set` already gives one row.
-- =========================================================================

DELETE FROM runner.settings stale
USING runner.settings newer
WHERE stale.key NOT IN ('dry-run-enabled', 'notify-webhook-url', 'notify-base-url', 'poller-enabled')
  AND newer.key = stale.key
  AND (newer.updated_at, newer.project) > (stale.updated_at, stale.project);

UPDATE runner.settings
SET project = '__deployment__'
WHERE key NOT IN ('dry-run-enabled', 'notify-webhook-url', 'notify-base-url', 'poller-enabled');

-- migrate:down

-- Once a row is rewritten under the reserved '__deployment__' project above,
-- nothing records which real project it used to belong to, so this cannot
-- restore the original key exactly. Reversing to `PROJECT_NAME`/'wilson',
-- the boot-configured project, would be a guess this migration has no way
-- to check — the same "cannot be reversed" position
-- 20260824160000_empty_needs_human_lane.sql takes for its own data-only
-- `up`. `down` is a no-op; the values these settings resolve to are
-- unaffected either way, since `SettingsStore.get` falls through to the
-- environment variable and then the coded default when no row matches.
SELECT 1;
