-- migrate:up

-- =========================================================================
-- Empty the `needs-human` lane before any code stops recognising it.
--
-- The lane is being retired in favour of the needs_human flag added above.
-- Once the retirement lands, `needs-human` drops out of `NON_STAGE_STATES`,
-- and a card left sitting there would be unmoveable (`validTargets` would
-- refuse it as a target) and unreadable to `nextCard`. So move every card
-- out first, in this migration, ahead of that code change.
--
-- The destination is `backlog`, not `implementing`, even though the card
-- was presumably mid-flight when it landed in `needs-human`. A card can
-- carry a `pinned_version_id`, and the dispatcher reads the card at that
-- pinned snapshot; the snapshot's `frontmatter.stage` still says
-- `needs-human`, so `assertDispatchable` would throw `wrong-stage`, which
-- `CardStageJob` now poisons instead of retrying. `backlog` is a manual
-- stage nothing dispatches, so the card simply waits for a person — which
-- is exactly what setting needs_human below is already telling you to do.
-- =========================================================================

UPDATE runner.cards
   SET stage = 'backlog',
       needs_human = TRUE,
       needs_human_reason = COALESCE(needs_human_reason, 'moved out of the retired needs-human lane')
 WHERE stage = 'needs-human';

-- migrate:down

-- This cannot be reversed: nothing records which of the cards now sitting
-- in `backlog` came from `needs-human` versus arrived there on their own.
-- Once the lane is emptied, that origin is gone, so `down` is a no-op.
SELECT 1;
