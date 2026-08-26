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
    | 'stage.poisoned'
    | 'stage.dead'
    | 'stage.stale'
    // Card 0100. Appended by `CardStageJob` at the moment it is about to dispatch a stage, when the
    // commit this process is running is behind the commit the card's worktree is about to be cut
    // from — never when the daemon is current, and never when it is merely *ahead* (a daemon ahead
    // of the base has not missed anything the base needs; see `HealthService.commitsBehind`).
    // Informational only: dispatch proceeds regardless, on the constraint that a daemon one commit
    // behind is the normal state of a running board, not an exceptional one to halt on.
    | 'daemon.stale'
    | 'dispatch.deferred'
    | 'engine.failed'
    | 'tool.denied'
    // The counterpart to `tool.denied`: a mutation or command that was allowed and actually ran,
    // carrying the same `tool` key plus `path` or `command` so the two read as one stream. One type
    // with a `tool` field, not one type per tool — the same choice `tool.denied` already made, and
    // splitting it would just make a reader switch on two fields instead of one.
    //
    // Deliberately does NOT cover `read`/`grep`/`glob`/search tools: those run hundreds of times per
    // stage, and an event each would swamp `card_events`, which backs `wilson card show` and the web
    // board, for rows nobody asks "what did this stage do" about. Do not "complete" this type by
    // wiring reads up to it.
    | 'tool.executed'
    | 'scope.requested'
    | 'scope.granted'
    | 'scope.refused'
    | 'scope.collateral'
    | 'worktree.created'
    | 'worktree.prepared'
    | 'work.committed'
    | 'worktree.reclaimed'
    | 'transition.written'
    | 'transition.failed'
    | 'external.transition'
    | 'chain.stopped'
    | 'card.flagged'
    | 'card.acked';

export interface CardEvent {
    project: string;
    cardId: string;
    stage?: string;
    type: CardEventType;
    payload?: Record<string, unknown>;
}
