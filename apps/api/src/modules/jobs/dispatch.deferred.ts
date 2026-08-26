import { BoardConfig } from '#modules/board/board.config.js';
import { EventLog } from '#modules/events/event.log.js';

/**
 * Record that a dispatch did not happen, and why, without touching the card.
 *
 * The one write shared by every "not now, not never" outcome — an unsatisfied dependency, a card
 * already flagged for a human, a scope conflict with a card in flight. None of them changes the
 * card's stage, its retries or its worktree; all of them need an operator to be able to see why the
 * chain did not move without reconstructing it from the board.
 *
 * `outstanding` is omitted from the payload rather than written as an empty array when the deferral
 * names no other card: the field means "these cards are in the way", and an empty list would read as
 * a deferral that had forgotten what it was waiting on.
 */
export const recordDeferral = async (
    deps: { board: BoardConfig; events: EventLog },
    args: { cardId: string; stageName: string; reason: string; outstanding?: string[] },
): Promise<void> => {
    const { cardId, stageName, reason, outstanding } = args;

    await deps.events.append({
        project: deps.board.project,
        cardId,
        stage: stageName,
        type: 'dispatch.deferred',
        payload: outstanding ? { outstanding, reason } : { reason },
    });
};
