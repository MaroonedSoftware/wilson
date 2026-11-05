-- migrate:up

-- What a goal's wake-ups have read, and when they may next run (PROJECT.md, Orchestration).
--
-- `last_event_id` is a cursor over wilson.card_events. NOTIFY is at-most-once and a restart loses it;
-- a cursor re-reads what it has not finished. It advances only once a wake-up's turn is stored.
-- `wake_held_until` holds a goal back after a turn failed, so a login that has expired costs one
-- attempt per hold rather than one per tick. Null when nothing holds it.
ALTER TABLE wilson.goals
    ADD COLUMN last_event_id BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN wake_held_until TIMESTAMPTZ;

-- migrate:down

ALTER TABLE wilson.goals
    DROP COLUMN last_event_id,
    DROP COLUMN wake_held_until;
