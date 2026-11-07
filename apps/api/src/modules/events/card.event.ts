/**
 * The vocabulary of the event log.
 *
 * Every entry is something the runner did or refused to do. Kept as a closed union so a reader can
 * switch exhaustively, and so a typo in a `type` string fails at compile time rather than becoming
 * an event nobody queries.
 */
export type CardEventType =
    | 'stage.dispatched'
    // Carries `host` and `slot`: the registered host a stage's `placement` put it on, and the
    // `wilson.leases` key holding its slot there. Absent for a stage that ran on this machine.
    | 'stage.placed'
    // Carries `host` and `reason`: a placed stage's host stopped answering before the stage ended.
    // The attempt is retried, not kicked back, and the host is marked as failing its probe.
    | 'stage.host-lost'
    // Carries `sessionId`: the engine's own id for this run's conversation, written when the `cli`
    // adapter first sees it and again if the engine moves to a new one, so the latest of these after
    // a `stage.dispatched` is what that attempt could resume from.
    | 'stage.engine-session'
    // Carries `trigger` (`auto` or `manual`), `preTokens` and, when the engine reports it, `postTokens`:
    // the `cli` engine summarized its conversation part way through a run. Not a failure. A count of
    // these beside a run's spend is how to tell whether a lane's `autoCompactWindow` is doing anything.
    | 'stage.compacted'
    // Carries `usage`: a daemon shutdown stopped the stage, which says nothing about the card, so
    // this is neither a pass nor a failure. The stage is sent again without spending a retry. Also
    // carries `usageLimit` and `heldUntil` when it was the account's usage limit that stopped it
    // instead, and the stage is sent again at `heldUntil`. Carries `hostLost` when it was losing its
    // host, saying why the host went.
    | 'stage.interrupted'
    | 'stage.passed'
    // Carries `blocked`, the question the stage stopped to ask, with `usage`, `changedPaths` and
    // `patchPath` as a `stage.failed` would. Neither a pass nor a failure: no retry is spent, and the
    // card waits for an answer.
    | 'stage.blocked'
    // Carries `patchPath` (card 0089): the deterministic path — `WorktreeManager.failedAttemptPatchPath`,
    // `<runRoot>/cards/<id>/last-failed-attempt.patch` — where `reclaim` preserves this attempt's
    // uncommitted work, including files it created but never tracked, the next time the card's
    // worktree is reclaimed. Named here regardless of *why* the stage failed — a thrown error or a
    // verification that simply did not pass, both leave work uncommitted the same way — and before
    // `reclaim` has necessarily run, since the path does not depend on that.
    //
    // Also carries `engineStopReason` (card 0118) when the `cli` adapter's engine said anything about
    // why its last message ended: the SDK `result` message's `subtype` and, when set, its
    // `stop_reason` — e.g. a turn that ended cleanly (`success`) without ever calling report_result,
    // or a subtype other than `success` naming its own cause instead of the generic "ran out of
    // steps" text. Absent whenever the SDK gave the adapter nothing to read one from: the runner's own
    // wall-clock/idle timeout firing before any `result` message arrived, or the stream closing with
    // no `result` message at all — both real, and neither guessed at (`cli.stage.agent.ts`,
    // `describeEngineStop`). Never present on `stage.passed`. A dead engine process is a different
    // signal entirely, carried on its own `errorClass`/`exitCode`/`signal` shape by `engine.failed`
    // below, not by this field.
    //
    // Also carries `failureClass` (`stage.result.ts`) and `reason`, the failure it leads with, cut to
    // `REASON_LIMIT`. Rows from before those were added have neither: `gate.stats.ts` matches their text.
    | 'stage.failed'
    | 'stage.poisoned'
    | 'stage.dead'
    | 'stage.stale'
    // Card 0261. A red run is not necessarily a regression: on 2026-09-19, card 0241's testing
    // attempt failed on a web test that passed on retry, and cards 0250 and 0253 each failed their
    // merge check on `project-switcher.test.ts`, which then passed 3 of 3 runs alone on the same
    // merge commit — three rounds that cost a stage run or a human apiece. `TestingVerifier` and
    // `BoardWriteService.proveMerge` (`testing.verifier.ts`, `board.write.service.ts`) both now
    // rerun, once, only the files a red run's report names as failing; a rerun that comes back
    // green appends this event instead of failing the run, carrying `tests` (the failing tests'
    // names, `describeFailingTest`-formatted), the stage the rerun happened in (the event's own
    // `stage` field), and `run` (`'testing'` or `'merge-check'`) naming which of the two reran them.
    // Recorded on the card, not folded into `stage.passed`'s own payload, so a *later* red run can
    // search for it: `TestingVerifier` fails outright, without a second rerun, when the card already
    // carries a `test.flaky` event naming one of the same tests — a recurring flake, not a one-off.
    // That is deliberately not a direct flag: a verifier cannot set `needsHuman` itself, so a
    // recurring flake only reaches a human the ordinary way, through `testing.onFail: testing` and
    // then `maxKickbacks`.
    | 'test.flaky'
    // A red run's failing tests that fail on the tree the card branched from too, so they were not
    // held against it. `TestingVerifier` reads that tree's report from its own baseline check and
    // appends this with `tests` (`failingTestKey`-formatted) and `run: 'testing'`; the merge check
    // reads it back, since it runs no baseline of its own, and appends one with `run: 'merge-check'`
    // when it exempts the same tests there.
    | 'test.preexisting'
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
    // A stage's prompt exceeded the model's context window (card 0072). Appended once, by
    // `CardStageJob`'s context-overflow flag, alongside the `needsHuman` flag it writes to the board
    // — never retried and never poisoned, the same "one attempt, then flag" shape `rebase.conflict`
    // gives a branch that cannot be rebased. Distinct from `stage.poisoned`: an overflow is a fact
    // about how big this stage's turn got, not about the deployment, and it is recoverable by doing
    // the stage differently — a fresh session on the same branch, or a smaller card — which is why
    // this is its own type rather than being folded into a poisoning. Payload carries `reason`, the
    // same text written to `needsHumanReason`.
    | 'context.overflow'
    // "Not now", not "never": nothing on the card changed, and the same dispatch succeeds unchanged
    // once whatever it is waiting on clears. Several causes write this, told apart by the payload's
    // `reason` text and whether `outstanding` is present — not by a count, which goes stale the next
    // time a cause is added (this comment already said "two" while there were three):
    //
    //   - an unsatisfied dependency carries `outstanding`, the card ids still in the way, alongside
    //     a "waiting on ..." reason;
    //   - a card already flagged for a human (`defer-flagged`) carries the flag's own reason;
    //   - a scope conflict (card 0104) names the other card and the paths they share;
    //   - a `StageConfigError` whose `stages.yaml` will not load omits `outstanding` entirely — that
    //     failure is true for every card that would load the file, not just this one, so there is no
    //     per-card dependency list to name — and its `reason` names the path and the parse or read
    //     failure instead.
    //
    // `classifyDispatchFailure`'s `defer`/`defer-flagged` arms and `PRE_DISPATCH_CHECKS` are where
    // these originate; that list is the authority, not this one.
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
    // Card 0126. The `cli` adapter's engine ended its turn cleanly (`subtype: 'success'`) having
    // called no tool at all — not even its own `report_result` — the shape shared by fifteen prior
    // instances (cards 0010 through 0117) that a stage ended its turn without calling
    // `report_result` and left an empty diff, most of them with no recorded reason at all until
    // card 0118 added `engineStopReason`. Appended by `CliStageAgent.run` itself, from inside the
    // run, rather than reconstructed afterwards from an empty diff and a missing report — see
    // `cli.stage.agent.ts`'s detection of it for why this one shape gets its own event instead of
    // being left to the generic `engineStopReason` text already carried on `stage.failed`: a count
    // of this type answers "how many times has exactly this happened" without re-parsing that
    // string off every card it appears on. Distinct from a stage that ran tools (wrote files, ran
    // a build) and merely forgot the final report call — that stage's `engineStopReason` looks the
    // same but `anyToolSeen` does not, and only the zero-tool-calls shape is recorded here, per
    // card 0126's "one reason so far" constraint. Payload carries `engineStopReason`, the same
    // SDK subtype/stop_reason text `describeEngineStop` produces. Never retried from here — the
    // stage still fails exactly as it did before this card (exit conditions are unchanged); this
    // is visibility recorded sooner, not a recovery attempt.
    | 'turn.empty'
    | 'tool.denied'
    // The counterpart to `tool.denied`: a mutation or command that was allowed and actually ran,
    // carrying the same `tool` key plus `path` or `command` so the two read as one stream. One type
    // with a `tool` field, not one type per tool — the same choice `tool.denied` already made, and
    // splitting it would just make a reader switch on two fields instead of one.
    //
    // Deliberately does NOT cover `read`/`grep`/`glob`/search tools: those run hundreds of times per
    // stage, and an event each would swamp `card_events`, which backs `wilson card show` and the web
    // board, for rows nobody asks "what did this stage do" about. Do not "complete" this type by
    // wiring reads up to it. What a run read is a bounded summary on its `stage.passed` or
    // `stage.failed` event instead, under `trace` (`run.trace.ts`): one field, no extra rows.
    | 'tool.executed'
    // Card 0248. `CliStageAgent`'s enforcement lives entirely inside `canUseTool`
    // (`createToolGuard`) — every Write, Edit and Bash the engine proposes is supposed to pass
    // through it before it runs — but nothing previously checked that the engine actually asked. On
    // 2026-09-19, against host engine 2.1.266, a diagnostic run made one Bash call (`true`) with a
    // `canUseTool` that refused everything, and the guard was never called at all: the command ran,
    // and neither `tool.denied` nor `tool.executed` landed for it. Appended once per guarded tool
    // call — Write, Edit or Bash — whose `tool_use` id reached a matching `tool_result` in a later
    // `user` message (the SDK's own evidence the call actually completed) without a `canUseTool`
    // consultation for that same id anywhere in the run; a `tool_use` still pending when the run is
    // cut off is not counted, matched by id rather than by name or ordering, so an id that was
    // merely denied or allowed never appears here. Payload carries `tool` and, mirroring
    // `tool.denied`'s shape, `command` for Bash or `path` for Write/Edit. Detection only — this card
    // does not make the engine consult the guard for a call it auto-approves; on the live board the
    // guard still sees most Bash calls (19 read-only commands such as `ls` and `cat` were refused
    // inside stages the same day), so this is not a wholesale bypass, just the calls that leave no
    // trace, which this event now records (`cli.stage.agent.ts`).
    | 'tool.unguarded'
    | 'scope.requested'
    | 'scope.granted'
    | 'scope.refused'
    | 'scope.collateral'
    | 'worktree.created'
    | 'worktree.prepared'
    // What `computeReviewEvidence` found before a review started: counts and any failure, not the text.
    | 'review.evidence'
    | 'work.committed'
    | 'worktree.reclaimed'
    // Carries `from`, `to` and `by`. A runner transition that sent a card back also carries
    // `failureClass`, which is `revise` for a review that asked for changes, and `reason`. So does one
    // that flagged a card, whose `reason` is the flag's. Rows from before those were added have neither.
    | 'transition.written'
    // A person approved a card's branch at one commit (`ReviewService.approve`). Carries `head`. A record
    // of the judgment and nothing more: it moves no stage and merging does not read it.
    | 'review.approved'
    | 'transition.failed'
    | 'external.transition'
    | 'chain.stopped'
    | 'card.flagged'
    | 'card.acked'
    // A person answered the question a stage stopped to ask. Carries `stage`, `question` and `answer`.
    | 'card.answered'
    /** `BoardWriteService.repin` moved the approved plan to a newer version. Payload: `from`, `to`, `by`. */
    | 'plan.repinned'
    // An image was added to a card, or removed from one. Each carries `attachmentId`, its sniffed
    // `contentType` and its `byteSize`. Neither is stage-scoped, so neither sets `stage`: a person
    // adds or removes one through the API whatever stage the card is in.
    | 'attachment.added'
    | 'attachment.removed'
    /**
     * The rule judges looked at this card's diff before a review. Payload: `verdicts`, and `usage` when
     * a call was made, which counts against the card's budget. Absent when no rule matched.
     */
    | 'rule.verdicts'
    /**
     * `RuleProposalJob` looked at a kickback's blockers for a rule. Payload: `proposal` when it drafted
     * one, which waits on a person, `reason` when it did not, and `usage`.
     */
    | 'rule.proposed'
    /** `AutoSplitter` split this card on a supported refusal. Payload: `pieces` and the refusal's `reason`. */
    | 'card.auto-split'
    /** `AutoSplitter` declined a supported refusal, which then routed as usual. Payload: `reason`. */
    | 'card.auto-split-skipped'
    /**
     * Merge proved the card and opened a GitHub pull request for it instead of moving `main`. The card
     * stays in `ready` until the pull request merges. Payload: `number`, `url`, `branch`, `sha`.
     */
    | 'card.pull-request-opened'
    /** The card's pull request was closed on GitHub without merging. Payload: `number`, `url`. */
    | 'card.pull-request-closed'
    /** `PlanDraftJob` saved a plan for a split piece or an unplanned card. It still waits for approval. */
    | 'card.plan-drafted'
    /** `PlanDraftJob` left a card unplanned, or it could not be enqueued. Payload: `reason`. */
    | 'card.plan-draft-skipped'
    // Card 0272. Appended once per `card.stage` job `BoundedCardStageJobRunner.start()`'s boot sweep
    // finds `active` in pg-boss with no daemon left that could be running it — the API is the only
    // daemon (card 0079), and a process that just started has an empty `RunningCards`, so any job the
    // sweep sees this way was orphaned by a crash, not genuinely in flight. The sweep fails it through
    // `PgBoss.fail` (never cancels it — see `CARD_STAGE_POLICY`'s own doc comment on why a fail, not a
    // cancel, is what keeps a repeatedly-crashing stage's retry budget honest) so it takes pg-boss's
    // ordinary 30-second retry path instead of waiting out `CARD_STAGE_EXPIRES_IN`'s hour. This event
    // is what tells a human reading the card's history why there is a gap between its last event
    // before the crash and the redelivered attempt picking back up. Payload carries `jobId` and
    // `startedOn` (the job's own `started_on`, ISO-formatted, or null if pg-boss never recorded one);
    // `stage` (the event's own top-level field, as every other stage-scoped event already uses it)
    // carries the stage name the orphaned job was running. Skipped, not appended with a guessed
    // project, when neither the job's own payload nor its `wilson.cardJobs` claim names one — the job
    // is still failed either way; see `CardJobs.activeCardStageJobs`/`claimForJob`.
    | 'job.orphaned';

export interface CardEvent {
    project: string;
    cardId: string;
    stage?: string;
    type: CardEventType;
    payload?: Record<string, unknown>;
}
