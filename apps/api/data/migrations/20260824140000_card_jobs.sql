-- migrate:up

-- =========================================================================
-- wilson.card_jobs — which job, if any, is currently carrying a card.
--
-- The runner had no way to answer "is this card in flight right now?". Three
-- problems came out of that one gap: a job could be redelivered while its stage
-- was still running, `card start` could enqueue a card that was already
-- running, and a stage left behind by a dead worker was indistinguishable from
-- one still working.
--
-- Operational state, not board state, so it is a table of its own rather than a
-- column on wilson.cards. `Card` and its frontmatter say nothing about jobs.
--
-- One row per card at most: a card has one job carrying it or none. The row is
-- a claim, never the answer — the broker's view of that job id decides, and a
-- row whose job has finished is deleted on read. See CardJobs.inFlight.
-- =========================================================================

CREATE TABLE wilson.card_jobs (
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project, card_id),
    FOREIGN KEY (project, card_id) REFERENCES wilson.cards (project, id) ON DELETE CASCADE
);

-- migrate:down

DROP TABLE wilson.card_jobs;
