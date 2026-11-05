-- migrate:up

-- =========================================================================
-- wilson.goals, wilson.goal_cards: a piece of work a chat thread sees through.
--
-- A goal is one thread and one project. A thread can touch several projects,
-- but one project is one board (PROJECT.md decision 9), and a goal watches a
-- board. `thread_id` is unique for the same reason a card has one plan: there
-- is one conversation to read for what a goal is about.
--
-- A card is in at most one goal, which is the primary key on goal_cards. The
-- foreign key to wilson.goals (id, project) refuses a card from another project
-- than its goal's.
-- =========================================================================

CREATE TABLE wilson.goals (
    id BIGSERIAL PRIMARY KEY,
    thread_id BIGINT NOT NULL UNIQUE REFERENCES wilson.chat_threads (id) ON DELETE CASCADE,
    project TEXT NOT NULL REFERENCES wilson.projects (name),
    title TEXT NOT NULL,
    -- What done looks like, in the person's terms.
    outcome TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done', 'abandoned')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (id, project)
);

SELECT wilson.add_updated_at_trigger('wilson.goals');

CREATE INDEX goals_project_status_idx ON wilson.goals (project, status);

CREATE TABLE wilson.goal_cards (
    project TEXT NOT NULL,
    card_id TEXT NOT NULL,
    goal_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project, card_id),
    FOREIGN KEY (project, card_id) REFERENCES wilson.cards (project, id) ON DELETE CASCADE,
    FOREIGN KEY (goal_id, project) REFERENCES wilson.goals (id, project) ON DELETE CASCADE
);

CREATE INDEX goal_cards_goal_id_idx ON wilson.goal_cards (goal_id);

-- migrate:down

DROP TABLE wilson.goal_cards;
DROP TABLE wilson.goals;
