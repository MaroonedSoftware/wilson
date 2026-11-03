-- migrate:up

-- A host's recent runs are its `stage.placed` events (`HostRepository.runs`), which name the host
-- only in their payload. The Hosts page reads them every ten seconds, and without this that is a
-- scan of the whole event log, most of which is tool calls.
CREATE INDEX card_events_placed_host_idx ON wilson.card_events ((payload ->> 'host'), id) WHERE type = 'stage.placed';

-- migrate:down

DROP INDEX wilson.card_events_placed_host_idx;
