/**
 * States that end a card's life.
 *
 * Deliberately narrower than `NON_STAGE_STATES` in `stage.config.ts`, which also includes
 * `parking-lot` — a parked card is waiting to be promoted, not finished, so it must not trigger
 * whatever a caller does for a terminal state (e.g. reclaiming the card's worktree). Keep this list
 * separate from `NON_STAGE_STATES` rather than deriving it, so the two do not silently drift back
 * together.
 */
const TERMINAL_STATES = new Set(['merged', 'dropped', 'poisoned', 'needs-human']);

export const isTerminal = (stage: string): boolean => TERMINAL_STATES.has(stage);
