-- migrate:up

-- =========================================================================
-- The activity feed reads one project's log newest first, across every card.
-- `card_events_project_card_id_idx` leads with the card, so it cannot serve
-- that without sorting the project's whole history.
-- =========================================================================

CREATE INDEX card_events_project_id_idx ON wilson.card_events (project, id);

-- migrate:down

DROP INDEX wilson.card_events_project_id_idx;
