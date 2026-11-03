/** The lane a card ends in, whatever way it ended. `doneReason` says which. */
export const DONE = 'done';

/** How a card ended. */
export type DoneReason = 'merged' | 'dropped' | 'poisoned' | 'split';

/**
 * The ways of ending, which a writer still names as a target: `move(id, { stage: 'merged' })`, or a
 * transition to `poisoned`. The repository stores any of them as `done` with that reason, so nothing
 * but it needs to know both words, and a released client still sending one keeps working. Events keep
 * the word too, which is what `StatusMirrorPoller` and the activity feeds read.
 *
 * `split` ends an origin an automatic split replaced: its pieces carry the work from there, and
 * `unsatisfiedDependencies` derives its completion from them, so a dependent is not stranded. Not
 * `dropped`, which `StatusMirrorPoller` reports to the card's source as the work being abandoned.
 */
export const DONE_REASONS: readonly DoneReason[] = ['merged', 'dropped', 'poisoned', 'split'];

/**
 * Whether a state ends a card's life.
 *
 * Deliberately narrower than `NON_STAGE_STATES` in `stage.config.ts`, which also includes
 * `parking-lot`: a parked card is waiting to be promoted, not finished, so it must not trigger whatever
 * a caller does for a terminal state (e.g. reclaiming the card's worktree).
 */
export const isTerminal = (stage: string): boolean => stage === DONE || (DONE_REASONS as readonly string[]).includes(stage);

/** The reason a target names, or undefined for any other state, `done` included. */
export const doneReasonFor = (stage: string): DoneReason | undefined =>
    (DONE_REASONS as readonly string[]).includes(stage) ? (stage as DoneReason) : undefined;

/** A route's target as a transition names it: a route to `done` means the work landed. */
export const endingOf = (target: string): string => (target === DONE ? 'merged' : target);

/** How a card ended, or undefined when it has not. */
export const endedAs = (card: { stage: string; doneReason?: string }): string | undefined => card.doneReason ?? doneReasonFor(card.stage);

/** Whether a card's work landed: the one way of ending that satisfies a card depending on it. */
export const hasMerged = (card: { stage: string; doneReason?: string }): boolean => endedAs(card) === 'merged';
