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
    // A card's branch could not be rebased onto the code repo's HEAD without a conflict (card 0103).
    // Appended once, by `CardStageJob`'s `flagRebaseConflict`, alongside the `needsHuman` flag it
    // writes to the board — never retried and never poisoned, so this is the only record of the
    // conflict a human gets without reading the daemon's log. Payload carries `branch`, `targetSha`
    // and `detail` (the git error `rebaseOntoHead` aborted on), which is everything the reason on
    // the card itself is built from.
    | 'rebase.conflict'
    // "Not now", not "never": nothing on the card changed, and the same dispatch succeeds unchanged
    // once whatever it is waiting on clears. `recordDeferral` writes this for two distinct causes,
    // told apart by the payload's `reason` text and the presence of `outstanding`: an unsatisfied
    // dependency carries `outstanding` (the card ids still in the way) alongside a "waiting on ..."
    // reason; a `StageConfigError` whose `stages.yaml` will not load omits `outstanding` entirely —
    // that failure is true for every card that would load the file, not just this one, so there is no
    // per-card dependency list to name — and its `reason` names the path and the parse or read
    // failure instead. See `classifyDispatchFailure`'s `defer` arm.
    | 'dispatch.deferred'
    // Card 0102. A handler can still be running after `runner.stop()` has already returned — that
    // is the premise `stopCardStageJobs`/card 0066 is built on — so `CardStageJob`'s own `broker.send`
    // handing the claim to the next job in a chain can throw on a connection pg-boss already closed
    // underneath it. By the time that happens the stage has already passed and its transition is
    // already written; only the handoff was lost. Appended in place of letting that throw (which
    // would make the queue retry a stage that already passed) or a `cardJobs.record` that runs
    // (which never happens here — that is the "no claim recorded" this event exists to explain).
    // Payload carries `target` (the stage the card actually landed on, per `outcome.transitionedTo`)
    // and `reason` (the `broker.send` error). The card is left in `target`, an ordinary agent stage,
    // so `whyNotDispatchable` sees nothing wrong with it: `wilson card start` picks it straight back
    // up, and so does `Poller.tick` if `POLLER_ENABLED` is on — which it is not by default, so this
    // event is the only signal an operator gets that the chain did not carry itself forward.
    | 'chain.orphaned'
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
