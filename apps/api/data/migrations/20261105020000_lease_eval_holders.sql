-- migrate:up

-- =========================================================================
-- wilson.leases — an eval run may hold one too.
--
-- An eval run takes a host slot like a stage does, under an id with no card
-- behind it (eval.run.id.ts). A row in wilson.cards would put it on the board,
-- which is what that id exists to avoid, so the foreign key moves to a column
-- that is empty for such an id. A key with an empty column is not checked, and
-- every card's lease stays exactly as checked and as cascaded as it was.
-- =========================================================================

ALTER TABLE wilson.leases
    ADD COLUMN held_card_id TEXT GENERATED ALWAYS AS (CASE WHEN card_id LIKE 'eval-%' THEN NULL ELSE card_id END) STORED,
    DROP CONSTRAINT leases_project_card_id_fkey,
    ADD CONSTRAINT leases_project_held_card_id_fkey FOREIGN KEY (project, held_card_id) REFERENCES wilson.cards (project, id) ON DELETE CASCADE;

-- migrate:down

DELETE FROM wilson.leases WHERE card_id LIKE 'eval-%';

ALTER TABLE wilson.leases
    DROP CONSTRAINT leases_project_held_card_id_fkey,
    DROP COLUMN held_card_id,
    ADD CONSTRAINT leases_project_card_id_fkey FOREIGN KEY (project, card_id) REFERENCES wilson.cards (project, id) ON DELETE CASCADE;
