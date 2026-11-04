-- migrate:up

-- The stats page reads a window of a few event types again on each stage's events. Without this that is
-- a scan of the project's whole log, most of which is tool calls. Partial, so those calls never touch it.
CREATE INDEX card_events_stats_idx ON wilson.card_events (project, created_at)
WHERE type IN (
    'stage.passed',
    'stage.failed',
    'stage.interrupted',
    'stage.blocked',
    'transition.written',
    'card.answered',
    'card.acked',
    'card.over-budget',
    'context.overflow',
    'rebase.conflict',
    'stage.poisoned',
    'stage.dead',
    'rule.verdicts',
    'rule.proposed'
);

-- migrate:down

DROP INDEX wilson.card_events_stats_idx;
