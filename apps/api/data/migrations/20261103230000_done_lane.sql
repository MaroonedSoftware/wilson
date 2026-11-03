-- migrate:up

-- merged, poisoned, dropped and split become one lane, `done`, and done_reason keeps which. Card events
-- and versions stay as written: they are history.
UPDATE wilson.cards SET stage = 'done' WHERE stage IN ('merged', 'poisoned', 'dropped', 'split');

UPDATE wilson.lanes SET on_pass = 'done' WHERE on_pass = 'merged';
UPDATE wilson.lanes SET on_fail = 'done' WHERE on_fail = 'merged';

-- migrate:down

UPDATE wilson.lanes SET on_pass = 'merged' WHERE on_pass = 'done';
UPDATE wilson.lanes SET on_fail = 'merged' WHERE on_fail = 'done';

UPDATE wilson.cards SET stage = done_reason WHERE stage = 'done' AND done_reason IS NOT NULL;
