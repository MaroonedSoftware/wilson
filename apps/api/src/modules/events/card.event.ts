/**
 * The vocabulary of the event log.
 *
 * Every entry is something the runner did or refused to do. Kept as a closed union so a reader can
 * switch exhaustively, and so a typo in a `type` string fails at compile time rather than becoming
 * an event nobody queries.
 */
export type CardEventType =
    | 'stage.dispatched'
    | 'stage.passed'
    | 'stage.failed'
    | 'tool.denied'
    | 'scope.requested'
    | 'scope.granted'
    | 'scope.refused'
    | 'worktree.created'
    | 'worktree.prepared'
    | 'worktree.reclaimed'
    | 'transition.written'
    | 'external.transition';

export interface CardEvent {
    project: string;
    cardId: string;
    stage?: string;
    type: CardEventType;
    payload?: Record<string, unknown>;
}
