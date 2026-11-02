-- migrate:up

-- =========================================================================
-- wilson.plan_turns.context_seen_id — the highest wilson.card_context id
-- a conversation has been given.
--
-- `PlanService` used to work out which snapshots a turn had not seen by
-- comparing `created_at`s, which read back at millisecond precision, so a
-- snapshot attached in the same millisecond as the last turn compared equal
-- and never arrived. One attached while the engine was still answering sat
-- before that turn's assistant row and never arrived either. An id cannot
-- tie, and it is recorded as the prompt is built, so neither can happen.
--
-- Set on the user row whose prompt was built from those snapshots, and left
-- null on assistant rows and on a turn with none to read past.
--
-- Backfilled the same way: a user row saw whatever was attached before it.
-- A snapshot that slipped through either gap reaches the card's next turn.
-- =========================================================================

ALTER TABLE wilson.plan_turns ADD COLUMN context_seen_id BIGINT;

UPDATE wilson.plan_turns turn
SET context_seen_id = (
    SELECT max(snapshot.id)
    FROM wilson.card_context snapshot
    WHERE snapshot.project = turn.project
      AND snapshot.card_id = turn.card_id
      AND snapshot.created_at < turn.created_at
)
WHERE turn.role = 'user';

-- migrate:down

ALTER TABLE wilson.plan_turns DROP COLUMN context_seen_id;
