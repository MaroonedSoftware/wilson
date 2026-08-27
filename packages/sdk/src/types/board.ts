import type { JsonValue } from '../sdk-options.js';

/**
 * The board's columns. They live in `config/stages.yaml` on the board repo, which a browser cannot
 * read — and a board that hard-codes its columns lies the first time a stage is added, which is
 * cheap to do precisely because stages are config.
 * generated from [BoardColumns](file://./../../../../apps/api/data/contracts/board.ck#L22)
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
 * generated from [CardSummary](file://./../../../../apps/api/data/contracts/board.ck#L32)
 */
export interface CardSummary {
    id: string;
    title: string;
    stage: string;
    branch?: string;
    dependsOn: string[];
    /**
     * Required, unlike the frontmatter's optional `needsHuman?`, so the web never has to write
     * `?? false` — every card has an answer to "does this need a human", even if that answer is no.
     */
    needsHuman: boolean;
    needsHumanReason?: string;
    position?: number;
}

/**
 * The write surface. Each request body is its own named contract rather than inlined on the
 * operation, for the same reason `ListQuery` is one: contractkit only honours a field's `?` down
 * the schema path a named type takes, and every one of card 0080's five mutations copies this shape.
 *
 * `id` never appears in a request body — it is either a path param (move, edit act on a card that
 * already exists) or, for create, assigned by the service the same way `wilson card create` assigns
 * it: the next sequential id over the current board. A client cannot pick one.
 * generated from [CreateCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L67)
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
 * generated from [MoveCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L77)
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
 * generated from [RepositionCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L89)
 */
export interface RepositionCardRequest {
    /** The card `id` should sit immediately after, or absent for the top of the column. */
    beforeId?: string;
    /** The card `id` should sit immediately before, or absent for the bottom of the column. */
    afterId?: string;
}

/**
 * generated from [EditCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L96)
 */
export interface EditCardRequest {
    body: string;
}

/**
 * Card 0094. Its own request shape rather than a `title` field on `EditCardRequest`: adding one there
 * would rename the generated SDK method `editCardBody` (and its caller and the test that names it)
 * for no behavioural gain, where `POST .../rename` is purely additive.
 * generated from [RenameCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L103)
 */
export interface RenameCardRequest {
    title: string;
}

/**
 * generated from [DependCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L107)
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
 * generated from [CardEvent](file://./../../../../apps/api/data/contracts/board.ck#L114)
 */
export interface CardEvent {
    id: string;
    type: string;
    stage: string | null;
    payload: JsonValue;
    createdAt: string;
}

/**
 * generated from [CardVersion](file://./../../../../apps/api/data/contracts/board.ck#L122)
 */
export interface CardVersion {
    id: string;
    message: string;
    createdAt: string;
}

/**
 * Shared by both history endpoints — a named contract so the generator takes the schema path
 * that honours `?`, rather than the inline `query: { limit?: int }` path that renders it required.
 * generated from [ListQuery](file://./../../../../apps/api/data/contracts/board.ck#L130)
 */
export interface ListQuery {
    limit?: number;
}

/**
 * Bootstrap: scaffolding and importing the board itself, not a card. Both operate on
 * `BoardConfig.boardRoot` — the path is server configuration, never a request field, so an endpoint
 * here is not a remote write-anywhere-on-disk primitive (card 0076).
 * generated from [ImportBoardRequest](file://./../../../../apps/api/data/contracts/board.ck#L137)
 */
export interface ImportBoardRequest {
    /**
     * Report what would happen without writing anything — the one affordance that makes a one-shot,
     * irreversible import safe to attempt. Absent (the default) writes.
     */
    dryRun?: boolean;
}

/**
 * generated from [ImportReport](file://./../../../../apps/api/data/contracts/board.ck#L143)
 */
export interface ImportReport {
    cards: number;
    dependencies: number;
    /**
     * Ids whose legacy `planSha` could not map to a version in the imported history, and were
     * re-pinned to the version this import created instead.
     */
    unpinned: string[];
    /** True for a dry run: nothing above was written, this is a preview. */
    skipped: boolean;
}

/**
 * Card 0077 splits `wilson card plan` into the half that must be local — the interactive `claude`
 * conversation itself, which needs the operator's own terminal — and the half that does not: cutting
 * the throwaway worktree, loading the `planning` stage's model and instructions, validating the
 * finished draft, writing it as a new card version, and tearing the worktree down. This contract is
 * the second half. The API owns the session; the CLI (unchanged until card 0074) will own spawning
 * `claude` with the operator's stdio against what this returns.
 * generated from [PlanSession](file://./../../../../apps/api/data/contracts/board.ck#L159)
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
 * generated from [SaveDraftRequest](file://./../../../../apps/api/data/contracts/board.ck#L182)
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
 * generated from [PlanTurnRequest](file://./../../../../apps/api/data/contracts/board.ck#L191)
 */
export interface PlanTurnRequest {
    text: string;
}

/**
 * One row of `runner.plan_turns` — a turn in a card's planning conversation, whether this is
 * `POST .../plan/turn`'s response (the just-appended assistant turn) or one of the entries
 * `GET .../plan/stream` replays after a client's `Last-Event-ID`.
 * generated from [PlanTurn](file://./../../../../apps/api/data/contracts/board.ck#L198)
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
 * Card 0113. One piece of a scope-check refusal's division (see `ScopeDivisionPieceSchema`,
 * apps/api/src/modules/stages/stage.result.ts) — carried over the wire twice: as reported, from
 * `GET .../division`, and again, possibly with `dependsOn` edited, in the body of `POST .../split`.
 * One shape for both directions so a client can round-trip a piece it only meant to touch one field
 * of.
 * generated from [DivisionPiece](file://./../../../../apps/api/data/contracts/board.ck#L212)
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
 * generated from [CardDetail](file://./../../../../apps/api/data/contracts/board.ck#L45)
 */
export interface CardDetail extends CardSummary {
    body: string;
    sections: Record<string, string>;
}

/**
 * `GET /api/cards/{id}/division`'s response: the most recent scope-check refusal on record for a
 * card. Read from the event log, not a fresh run — `scope-check` already happened, and re-running it
 * could return a different division for the cost of a whole pass, which is `scope-check`'s job to
 * spend, not this endpoint's.
 * generated from [CardDivision](file://./../../../../apps/api/data/contracts/board.ck#L228)
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
 * generated from [SplitCardsRequest](file://./../../../../apps/api/data/contracts/board.ck#L240)
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
 * generated from [ReleaseResult](file://./../../../../apps/api/data/contracts/board.ck#L56)
 */
export interface ReleaseResult extends CardDetail {
    releasedAs: 'queued' | 'orphan';
}

/**
 * `POST /api/cards/{id}/split`'s response: the origin card, re-read after being annotated with the
 * ids it produced, and the cards created from each piece, in the order `pieces` was sent. Every
 * created card lands in `planning`, never `backlog` — a piece is a title, a task list and a
 * sentence, not a plan with all six headings filled in.
 * generated from [SplitResult](file://./../../../../apps/api/data/contracts/board.ck#L248)
 */
export interface SplitResult {
    origin: CardDetail;
    pieces: CardDetail[];
}
