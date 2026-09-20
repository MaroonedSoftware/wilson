import type { JsonValue } from '../sdk-options.js';

/**
 * The board's columns. They come from the project's stage config (a `runner.stage_configs` row,
 * `StageConfigStore`), which a browser has no business reading whole — and a board that hard-codes
 * its columns lies the first time a stage is added, which is cheap to do precisely because stages
 * are config.
 * generated from [BoardColumns](file://./../../../../apps/api/data/contracts/board.ck#L24)
 */
export interface BoardColumns {
    /** configured stages, in the order they run */
    stages: string[];
    /** parking-lot and the terminal states */
    nonStages: string[];
}

/**
 * Card 0091. Orders the parking lot; `list`'s `position, id` ordering (PostgresBoardRepository)
 * sorts a card with one ahead of every card without. Absent for a card nothing has ever dragged —
 * including every card that predates this, since there is no migration to back-fill it — and such a
 * card sorts by `id` among the others like it, not at either end of the column. Meaningless outside
 * `parking-lot`: no other stage's order is an operator's to set (POST .../reposition refuses it).
 * generated from [CardSummary](file://./../../../../apps/api/data/contracts/board.ck#L34)
 */
export interface CardSummary {
    id: string;
    title: string;
    stage: string;
    branch?: string;
    /**
     * Card 0160. `WorktreeManager.resolveBranch`'s own answer — `branch` above when something
     * recorded one, otherwise the same derivation from the card's title `branchName` computes.
     * `branch` alone cannot answer "which branch is this card's work on" for most cards (card 0095),
     * and re-deriving the fallback anywhere but `WorktreeManager` would risk drifting from it, so this
     * is that single answer carried onto the wire rather than a second copy of its logic. Optional
     * because only the reads `BoardService` itself serves (`list`, `getById`) compute it; a write
     * response built through `BoardWriteService`/`PlanService`'s shared `toCardDetail` leaves it
     * absent rather than guess.
     */
    resolvedBranch?: string;
    dependsOn: string[];
    /**
     * Required, unlike the frontmatter's optional `needsHuman?`, so the web never has to write
     * `?? false` — every card has an answer to "does this need a human", even if that answer is no.
     */
    needsHuman: boolean;
    needsHumanReason?: string;
    position?: number;
    /**
     * Card 0178. The moment this card entered its current stage — the most recent
     * `transition.written` event's timestamp, or its earliest recorded event if the card has never
     * transitioned, mirroring `wilson card show`'s own `timeInCurrentStage` derivation
     * (apps/api/src/modules/events/time.in.stage.ts, factored out as `stageEnteredAt` there).
     * Populated only by the reads `BoardService` itself serves (`list`, `getById`), the same way
     * `resolvedBranch` above is: a write response built through `BoardWriteService`/`PlanService`'s
     * shared `toCardDetail` leaves it absent rather than guess. Also absent for a card whose fetched
     * event history holds no events at all, or whose fetched window is full of events with no
     * transition among them — a history that cannot answer the question either way, not the same
     * fact as "just entered".
     */
    stageEnteredAt?: string;
}

/**
 * The write surface. Each request body is its own named contract rather than inlined on the
 * operation, for the same reason `ListQuery` is one: contractkit only honours a field's `?` down
 * the schema path a named type takes, and every one of card 0080's five mutations copies this shape.
 *
 * `id` never appears in a request body — it is either a path param (move, edit act on a card that
 * already exists) or, for create, assigned by the service the same way `wilson card create` assigns
 * it: the next sequential id over the current board. A client cannot pick one.
 * generated from [CreateCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L103)
 */
export interface CreateCardRequest {
    title: string;
    /** Defaults to parking-lot — same default `wilson card create --stage` uses. */
    stage?: string;
    /**
     * The full plan body. The CLI seeds `$EDITOR` with a skeleton and a human fills it in there;
     * there is no terminal on the other end of an HTTP call, so the caller sends the finished text
     * directly rather than a seed to edit interactively.
     */
    body: string;
}

/**
 * generated from [MoveCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L113)
 */
export interface MoveCardRequest {
    /**
     * The target stage. Validated against the board's own stage graph (`validTargets`), exactly as
     * `wilson card move` validates it — not against a fixed enum here, because the graph is config
     * and can grow a stage without a contract change.
     */
    stage: string;
}

/**
 * Card 0091. The two cards `id` should land between in the parking lot, by id rather than by a
 * position value: a value would leak the sparse-integer scheme (`card.position.ts`) onto the wire,
 * where a client would have no way to compute one that is still valid by the time this request
 * lands. Either may be absent — both absent together means "the only card in the column" — since a
 * drop can land at either end, where there is nothing on that side to name.
 * generated from [RepositionCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L125)
 */
export interface RepositionCardRequest {
    /** The card `id` should sit immediately after, or absent for the top of the column. */
    beforeId?: string;
    /** The card `id` should sit immediately before, or absent for the bottom of the column. */
    afterId?: string;
}

/**
 * generated from [EditCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L132)
 */
export interface EditCardRequest {
    body: string;
}

/**
 * Card 0094. Its own request shape rather than a `title` field on `EditCardRequest`: adding one there
 * would rename the generated SDK method `editCardBody` (and its caller and the test that names it)
 * for no behavioural gain, where `POST .../rename` is purely additive.
 * generated from [RenameCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L139)
 */
export interface RenameCardRequest {
    title: string;
}

/**
 * generated from [DependCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L143)
 */
export interface DependCardRequest {
    dependsOnId: string;
    /**
     * Absent (the default) records the dependency; `true` drops it instead — mirroring `wilson card
     * depend`'s `--remove` flag.
     */
    remove?: boolean;
}

/**
 * generated from [CardEvent](file://./../../../../apps/api/data/contracts/board.ck#L150)
 */
export interface CardEvent {
    id: string;
    type: string;
    stage: string | null;
    payload: JsonValue;
    createdAt: string;
}

/**
 * generated from [CardVersion](file://./../../../../apps/api/data/contracts/board.ck#L158)
 */
export interface CardVersion {
    id: string;
    message: string;
    createdAt: string;
}

/**
 * Card 0263. What a card cost in one stage — every `stage.passed`/`stage.failed` event for it,
 * summed. `attempts` counts the passed and failed events themselves, including one whose payload
 * carried no `usage` at all (it still ran); `inputTokens`/`outputTokens` sum whatever `usage` those
 * events did carry, so the two can never disagree with the event log.
 * generated from [CardStageUsage](file://./../../../../apps/api/data/contracts/board.ck#L168)
 */
export interface CardStageUsage {
    stage: string;
    attempts: number;
    inputTokens: number;
    outputTokens: number;
}

/**
 * Card 0265. One file changed in a card's branch since it forked from `main` —
 * `WorktreeManager.patchSinceFork`'s per-file entry, carried onto the wire. `status` comes from
 * `git diff --name-status --no-renames`, so a rename always reads as a delete and an add, matching
 * what `changedPaths`/the reviewer already see (this card's Constraints).
 * generated from [CardDiffFile](file://./../../../../apps/api/data/contracts/board.ck#L194)
 */
export interface CardDiffFile {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    /** The unified patch text for this file alone, empty when `truncated` is true. */
    patch: string;
    /**
     * True when this file's own patch exceeded the per-file cap, or the response's total patch
     * budget was already spent by the time this file was reached — either way `patch` is empty.
     */
    truncated: boolean;
}

/**
 * Shared by both history endpoints — a named contract so the generator takes the schema path
 * that honours `?`, rather than the inline `query: { limit?: int }` path that renders it required.
 * generated from [ListQuery](file://./../../../../apps/api/data/contracts/board.ck#L220)
 */
export interface ListQuery {
    limit?: number;
}

/**
 * Card 0077 splits `wilson card plan` into the half that must be local — the interactive `claude`
 * conversation itself, which needs the operator's own terminal — and the half that does not: cutting
 * the throwaway worktree, loading the `planning` stage's model and instructions, validating the
 * finished draft, writing it as a new card version, and tearing the worktree down. This contract is
 * the second half. The API owns the session; the CLI (unchanged until card 0074) will own spawning
 * `claude` with the operator's stdio against what this returns.
 * generated from [PlanSession](file://./../../../../apps/api/data/contracts/board.ck#L230)
 */
export interface PlanSession {
    /**
     * Identifies this session for the `save`/`close` calls that follow. Deterministically the card's
     * own id, not an opaque token from a session table: the worktree and its branch are always cut
     * as `plan-<id>` / a branch keyed off `<id>` (never the card's real path or branch — card 0058's
     * guard), so there is exactly one live planning session per card, and opening a new one for the
     * same id is what recovers a session whose CLI died mid-conversation. Carried as its own field
     * regardless, so this response names what it is rather than leaving a caller to assume it equals
     * the path param.
     */
    sessionId: string;
    /** Absolute path to the throwaway worktree the spawned agent should be pointed at. */
    worktreePath: string;
    /**
     * Where the finished plan must be written, and the one file writes to it are allowed against.
     * Already seeded: the card's existing body if it has sections, the six-heading skeleton
     * otherwise — same seed `wilson card plan` writes today.
     */
    draftPath: string;
    /** The `planning` stage's own model, from `stages.yaml` — never a string this contract pins. */
    model: string;
    /**
     * The `planning` stage's own instructions, plus the one fact only this session knows: where the
     * draft lives. Meant to travel as the spawned agent's appended system prompt, with the same
     * weight as its base instructions, not as a user turn it might treat as negotiable.
     */
    instructions: string;
}

/**
 * generated from [SaveDraftRequest](file://./../../../../apps/api/data/contracts/board.ck#L253)
 */
export interface SaveDraftRequest {
    /**
     * The finished draft's full body, six headings included. There is no terminal on the other end
     * of an HTTP call for a confirmation prompt — "approval is explicit and versioned" is enforced by
     * the caller showing a diff and asking before this is ever sent, not by this contract.
     */
    body: string;
}

/**
 * Card 0133: the daemon can hold a planning conversation for a card itself. `POST .../plan/turn`'s
 * request — one message in that conversation.
 * generated from [PlanTurnRequest](file://./../../../../apps/api/data/contracts/board.ck#L262)
 */
export interface PlanTurnRequest {
    text: string;
    /**
     * Card 0240. `chat`, the default, sends exactly `text`. `cuts` prepends `PlanService`'s
     * `cutsPreamble` to the prompt the engine sees — this contract carries no cuts-specific fields
     * of its own because the preamble, not the request shape, is what changes.
     */
    mode?: 'chat' | 'cuts';
}

/**
 * One row of `runner.plan_turns` — a turn in a card's planning conversation, whether this is
 * `POST .../plan/turn`'s response (the just-appended assistant turn) or one of the entries
 * `GET .../plan/stream` replays after a client's `Last-Event-ID`.
 * generated from [PlanTurn](file://./../../../../apps/api/data/contracts/board.ck#L273)
 */
export interface PlanTurn {
    /**
     * `Last-Event-ID`'s resume key: monotonic per card, so a reconnecting client asks for every turn
     * with `seq` greater than the last one it saw.
     */
    seq: number;
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
}

/**
 * Card 0140. `open` writes `draft.md` and hands back its server-local path (`PlanSession.draftPath`)
 * — no use to a browser, which is never on the same filesystem the CLI is (card 0077's split). This
 * is the content a client reads instead: exactly what is on disk, whether that is the seed `open`
 * wrote, a draft the agent is partway through, or the last thing `save` wrote before the session
 * closed. See `PlanService.draft` for what an id with no draft yet gets instead of this.
 * generated from [PlanDraft](file://./../../../../apps/api/data/contracts/board.ck#L287)
 */
export interface PlanDraft {
    body: string;
}

/**
 * Card 0146. A comment left on a passage of a plan draft — what a person could point at but had
 * nowhere to put. Stores exactly the anchor [[0145]]'s `Anchor` captures — the quote plus its
 * surrounding window — never a resolved position: the draft is rewritten whole on every planning
 * turn, so a stored offset would be wrong by the very next revision. `resolved` is a state a
 * comment moves through, not a delete — a comment the agent addressed stays on record.
 * generated from [PlanComment](file://./../../../../apps/api/data/contracts/board.ck#L296)
 */
export interface PlanComment {
    id: string;
    quote: string;
    prefix: string;
    suffix: string;
    text: string;
    resolved: boolean;
    createdAt: string;
}

/**
 * `POST .../plan/comments`'s request — the anchor a client already captured
 * (`captureAnchor`, apps/web/src/lib/anchor.ts) plus what the person said about it.
 * generated from [CreatePlanCommentRequest](file://./../../../../apps/api/data/contracts/board.ck#L308)
 */
export interface CreatePlanCommentRequest {
    quote: string;
    prefix: string;
    suffix: string;
    text: string;
}

/**
 * Card 0113. One piece of a scope-check refusal's division (see `ScopeDivisionPieceSchema`,
 * apps/api/src/modules/stages/stage.result.ts) — carried over the wire twice: as reported, from
 * `GET .../division`, and again, possibly with `dependsOn` edited, in the body of `POST .../split`.
 * One shape for both directions so a client can round-trip a piece it only meant to touch one field
 * of.
 * generated from [DivisionPiece](file://./../../../../apps/api/data/contracts/board.ck#L320)
 */
export interface DivisionPiece {
    title: string;
    tasks: string[];
    delivers: string;
    /**
     * Titles of other pieces in the same division this piece's own report named as blocking it.
     * `ScopeDivisionPieceSchema` defaults this to `[]` whether the model said "independent" or simply
     * did not say — an empty array here is not proof of independence. A client must show this field
     * as reported and let an operator add to it before anything is created; it must not try to infer
     * a missing dependency from `delivers` prose.
     */
    dependsOn: string[];
}

/**
 * Card 0193, extended by card 0241's `scopeConflict` kind and card 0245's `acceptanceCriteria` kind.
 * One thing `PlanLintService` found wrong with a plan when checked against the config the runner will
 * actually enforce — never a judgement on the plan's prose (that stays a human's job, or `review`'s),
 * only what a stage's own `CommandAllowlist`, a project's `alwaysAllowed` list, the literal shape of a
 * `Files in scope` line, (card 0241) whether that scope overlaps a card already in flight, or (card
 * 0245) whether the plan's own `Acceptance criteria` section is one `acceptanceCriteria(card)` cannot
 * trace cleanly, actually decide. `kind` names which of the checks produced it; `message` already
 * carries whatever specifics matter (the allowlist's own refusal reason, the glob this suggests, which
 * `alwaysAllowed` entry already covers the line, which patterns and card an overlap was found against,
 * which criterion IDs collide or which section had text but no bullets) rather than splitting them
 * into fields a client would have to reassemble into the same sentence.
 * generated from [LintFinding](file://./../../../../apps/api/data/contracts/board.ck#L372)
 */
export interface LintFinding {
    kind: 'command' | 'alwaysAllowed' | 'scopeConflict' | 'acceptanceCriteria';
    message: string;
}

/**
 * generated from [CardDetail](file://./../../../../apps/api/data/contracts/board.ck#L67)
 */
export interface CardDetail extends CardSummary {
    body: string;
    sections: Record<string, string>;
}

/**
 * `GET /api/cards/{id}/usage`'s response: what a card has cost, read from `EventLog.usageByStage`
 * rather than tracked as a separate running total (`card_events` stays the one record — this card's
 * Constraints). `total` sums every stage; `stages` breaks that down one row per stage, in the order
 * each stage was first run, not alphabetically. Tokens only, never a dollar figure: every stage on
 * this board runs through the subscription-billed `cli` adapter, which reports no cost to sum, and
 * these numbers are for a human reading what a card spent, not a bill (Out of scope: capturing one).
 * generated from [CardUsage](file://./../../../../apps/api/data/contracts/board.ck#L181)
 */
export interface CardUsage {
    total: { attempts: number; inputTokens: number; outputTokens: number };
    stages: CardStageUsage[];
}

/**
 * `GET /api/cards/{id}/diff`'s response: every file the card's branch touched since
 * `merge-base(main, branch)`, one basis for the diff the CLI's own `wilson card diff` already uses
 * (this card's Constraints). `files` empty and `truncated` false together is a real, distinct
 * outcome — a branch that exists but changed nothing — from the 400 below, which means no branch
 * was ever cut at all.
 * generated from [CardDiff](file://./../../../../apps/api/data/contracts/board.ck#L209)
 */
export interface CardDiff {
    base: string;
    files: CardDiffFile[];
    /**
     * True once the response's total patch budget (2 MB) was spent and at least one later file's
     * patch was left out — distinct from an individual file's own `truncated`, which can be true
     * while this stays false.
     */
    truncated: boolean;
}

/**
 * `GET /api/cards/{id}/division`'s response: the most recent scope-check refusal on record for a
 * card. Read from the event log, not a fresh run — `scope-check` already happened, and re-running it
 * could return a different division for the cost of a whole pass, which is `scope-check`'s job to
 * spend, not this endpoint's.
 * generated from [CardDivision](file://./../../../../apps/api/data/contracts/board.ck#L336)
 */
export interface CardDivision {
    /**
     * The refusal's own stated reason (`ScopeCheckResultSchema.reason`) — repetition, named in the
     * model's own words, not merely "refused".
     */
    reason: string;
    pieces: DivisionPiece[];
}

/**
 * `POST /api/cards/{id}/split`'s request: every piece to create, exactly as an operator confirmed
 * it — `title`/`tasks`/`delivers` as `scope-check` reported them, `dependsOn` as the operator left it
 * after being shown what was reported and given the chance to add to it. The endpoint does not go
 * back to the event log to re-read the division itself; the confirmed pieces are the only truth it
 * acts on.
 * generated from [SplitCardsRequest](file://./../../../../apps/api/data/contracts/board.ck#L348)
 */
export interface SplitCardsRequest {
    pieces: DivisionPiece[];
}

/**
 * `BoardWriteService.release`'s response (card 0087): the card, plus which of the two safe-to-cancel
 * cases it took. `queued` is a job in `created` or `retry` — by definition nothing has picked it up,
 * so cancelling it cannot interrupt anything. `orphan` is a job the broker still shows `active` but
 * that this process's own tracking confirms nothing is currently running — left behind by an earlier
 * process that crashed before it could clear or hand off. A job genuinely mid-run stays refused (see
 * the release operation's 400 below) and never reaches this response at all.
 * generated from [ReleaseResult](file://./../../../../apps/api/data/contracts/board.ck#L78)
 */
export interface ReleaseResult extends CardDetail {
    releasedAs: 'queued' | 'orphan';
}

/**
 * Card 0143. `POST /api/cards/{id}/merge`'s response: the card, plus what the attempt actually did.
 * A conflict and a suite failure are not bad input — they are two of the three honest outcomes an
 * attempt can have, the same way `ReleaseResult.releasedAs` names which safe-to-cancel case a
 * release was, so both come back as `merged: false` with `reason` in a 200, not a 400. The only
 * thing this operation refuses outright is a card that is not in `ready` (see its 400 below).
 * generated from [MergeResult](file://./../../../../apps/api/data/contracts/board.ck#L87)
 */
export interface MergeResult extends CardDetail {
    merged: boolean;
    /** The commit `main` now points at, present only when `merged` is true. */
    commit?: string;
    /**
     * Why the attempt did not land — a conflict naming the paths, or the suite's own failure —
     * present only when `merged` is false.
     */
    reason?: string;
}

/**
 * `POST /api/cards/{id}/split`'s response: the origin card, re-read after being annotated with the
 * ids it produced, and the cards created from each piece, in the order `pieces` was sent. Every
 * created card lands in `planning`, never `backlog` — a piece is a title, a task list and a
 * sentence, not a plan with all six headings filled in.
 * generated from [SplitResult](file://./../../../../apps/api/data/contracts/board.ck#L356)
 */
export interface SplitResult {
    origin: CardDetail;
    pieces: CardDetail[];
}
