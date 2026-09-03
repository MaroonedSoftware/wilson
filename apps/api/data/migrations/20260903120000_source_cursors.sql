-- migrate:up

-- =========================================================================
-- runner.source_cursors — where each card source left off.
--
-- Third of six in card sources (PROJECT.md, "Card sources"), the table
-- card 0198's poll reads and writes. A CardSource answers
-- changedSince(cursor) (card 0196); this is where that cursor lives
-- between ticks, so a poll asks for what changed rather than re-reading a
-- whole ticket system every interval.
--
-- One row per (project, source), keyed the way runner.settings and
-- runner.card_jobs are already keyed. `source` is the same name a ref is
-- stored under in cards.external — `linear`, `github` — so the cursor and
-- the refs it produced agree on one spelling of a source.
--
-- Deliberately not a row in runner.settings, which would have needed no
-- migration at all. That table is scoped by its own note to operational
-- policy an operator changes while the system runs; a cursor is the
-- opposite, machine-written state no operator should be editing, and
-- putting it there would have made that table mean two things.
--
-- `cursor` is TEXT and opaque to everything here: a timestamp for one
-- source, an ETag or an opaque page token for another. The board never
-- parses it, only hands back whatever the source last gave it. NULL is
-- not a value it takes — a source with no cursor yet has no row, which
-- SourceCursorRepository.get reports as undefined and card 0196's
-- interface documents as "since the beginning".
--
-- Written by hand rather than by the card that needs it: card 0192
-- decided migrations stay a human step, so no stage carries the migration
-- tooling. Applied to the dev and test databases before card 0198 runs,
-- which is what lets that card's own tests execute — the thing card 0185
-- could not do, and the reason 0192 was filed at all.
-- =========================================================================

CREATE TABLE runner.source_cursors (
    project TEXT NOT NULL,
    source TEXT NOT NULL,
    cursor TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project, source)
);

-- migrate:down

DROP TABLE runner.source_cursors;
