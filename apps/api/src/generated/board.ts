import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);
type _JsonValue = string | number | boolean | null | _JsonValue[] | { [key: string]: _JsonValue };
const _ZodJson: z.ZodType<_JsonValue> = z.lazy(() =>
    z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(_ZodJson), z.record(z.string(), _ZodJson)]),
);

/**
 * The board's columns. They come from the project's stage config (a `runner.stage_configs` row,
 * `StageConfigStore`), which a browser has no business reading whole — and a board that hard-codes
 * its columns lies the first time a stage is added, which is cheap to do precisely because stages
 * are config.
 * generated from [BoardColumns](file://./../../data/contracts/board.ck#L23)
 */
export const BoardColumns = z.strictObject({
    stages: z.array(z.string()).describe('configured stages, in the order they run'),
    nonStages: z.array(z.string()).describe('parking-lot and the terminal states'),
});
export type BoardColumns = z.infer<typeof BoardColumns>;

/**
 * Card 0091. Orders the parking lot; `list`'s `position, id` ordering (PostgresBoardRepository)
 * sorts a card with one ahead of every card without. Absent for a card nothing has ever dragged —
 * including every card that predates this, since there is no migration to back-fill it — and such a
 * card sorts by `id` among the others like it, not at either end of the column. Meaningless outside
 * `parking-lot`: no other stage's order is an operator's to set (POST .../reposition refuses it).
 * generated from [CardSummary](file://./../../data/contracts/board.ck#L33)
 */
export const CardSummary = z.strictObject({
    id: z.string(),
    title: z.string(),
    stage: z.string(),
    branch: z.string().optional(),
    resolvedBranch: z
        .string()
        .optional()
        .describe(
            "Card 0160. `WorktreeManager.resolveBranch`'s own answer — `branch` above when something\nrecorded one, otherwise the same derivation from the card's title `branchName` computes.\n`branch` alone cannot answer \"which branch is this card's work on\" for most cards (card 0095),\nand re-deriving the fallback anywhere but `WorktreeManager` would risk drifting from it, so this\nis that single answer carried onto the wire rather than a second copy of its logic. Optional\nbecause only the reads `BoardService` itself serves (`list`, `getById`) compute it; a write\nresponse built through `BoardWriteService`/`PlanService`'s shared `toCardDetail` leaves it\nabsent rather than guess.",
        ),
    dependsOn: z.array(z.string()),
    needsHuman: z
        .preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
        .describe(
            'Required, unlike the frontmatter\'s optional `needsHuman?`, so the web never has to write\n`?? false` — every card has an answer to "does this need a human", even if that answer is no.',
        ),
    needsHumanReason: z.string().optional(),
    position: z.coerce.number().int().optional(),
    stageEnteredAt: _ZodDatetime
        .optional()
        .describe(
            "Card 0178. The moment this card entered its current stage — the most recent\n`transition.written` event's timestamp, or its earliest recorded event if the card has never\ntransitioned, mirroring `wilson card show`'s own `timeInCurrentStage` derivation\n(apps/api/src/modules/events/time.in.stage.ts, factored out as `stageEnteredAt` there).\nPopulated only by the reads `BoardService` itself serves (`list`, `getById`), the same way\n`resolvedBranch` above is: a write response built through `BoardWriteService`/`PlanService`'s\nshared `toCardDetail` leaves it absent rather than guess. Also absent for a card whose fetched\nevent history holds no events at all, or whose fetched window is full of events with no\ntransition among them — a history that cannot answer the question either way, not the same\nfact as \"just entered\".",
        ),
});
export type CardSummary = z.infer<typeof CardSummary>;

/**
 * The write surface. Each request body is its own named contract rather than inlined on the
 * operation, for the same reason `ListQuery` is one: contractkit only honours a field's `?` down
 * the schema path a named type takes, and every one of card 0080's five mutations copies this shape.
 *
 * `id` never appears in a request body — it is either a path param (move, edit act on a card that
 * already exists) or, for create, assigned by the service the same way `wilson card create` assigns
 * it: the next sequential id over the current board. A client cannot pick one.
 * generated from [CreateCardRequest](file://./../../data/contracts/board.ck#L102)
 */
export const CreateCardRequest = z.strictObject({
    title: z.string(),
    stage: z.string().optional().describe('Defaults to parking-lot — same default `wilson card create --stage` uses.'),
    body: z
        .string()
        .describe(
            'The full plan body. The CLI seeds `$EDITOR` with a skeleton and a human fills it in there;\nthere is no terminal on the other end of an HTTP call, so the caller sends the finished text\ndirectly rather than a seed to edit interactively.',
        ),
});
export type CreateCardRequest = z.infer<typeof CreateCardRequest>;

/**
 * generated from [MoveCardRequest](file://./../../data/contracts/board.ck#L112)
 */
export const MoveCardRequest = z.strictObject({
    stage: z
        .string()
        .describe(
            "The target stage. Validated against the board's own stage graph (`validTargets`), exactly as\n`wilson card move` validates it — not against a fixed enum here, because the graph is config\nand can grow a stage without a contract change.",
        ),
});
export type MoveCardRequest = z.infer<typeof MoveCardRequest>;

/**
 * Card 0091. The two cards `id` should land between in the parking lot, by id rather than by a
 * position value: a value would leak the sparse-integer scheme (`card.position.ts`) onto the wire,
 * where a client would have no way to compute one that is still valid by the time this request
 * lands. Either may be absent — both absent together means "the only card in the column" — since a
 * drop can land at either end, where there is nothing on that side to name.
 * generated from [RepositionCardRequest](file://./../../data/contracts/board.ck#L124)
 */
export const RepositionCardRequest = z.strictObject({
    beforeId: z.string().optional().describe('The card `id` should sit immediately after, or absent for the top of the column.'),
    afterId: z.string().optional().describe('The card `id` should sit immediately before, or absent for the bottom of the column.'),
});
export type RepositionCardRequest = z.infer<typeof RepositionCardRequest>;

/**
 * generated from [EditCardRequest](file://./../../data/contracts/board.ck#L131)
 */
export const EditCardRequest = z.strictObject({
    body: z.string(),
});
export type EditCardRequest = z.infer<typeof EditCardRequest>;

/**
 * Card 0094. Its own request shape rather than a `title` field on `EditCardRequest`: adding one there
 * would rename the generated SDK method `editCardBody` (and its caller and the test that names it)
 * for no behavioural gain, where `POST .../rename` is purely additive.
 * generated from [RenameCardRequest](file://./../../data/contracts/board.ck#L138)
 */
export const RenameCardRequest = z.strictObject({
    title: z.string(),
});
export type RenameCardRequest = z.infer<typeof RenameCardRequest>;

/**
 * generated from [DependCardRequest](file://./../../data/contracts/board.ck#L142)
 */
export const DependCardRequest = z.strictObject({
    dependsOnId: z.string(),
    remove: z
        .preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
        .optional()
        .describe("Absent (the default) records the dependency; `true` drops it instead — mirroring `wilson card\ndepend`'s `--remove` flag."),
});
export type DependCardRequest = z.infer<typeof DependCardRequest>;

/**
 * generated from [CardEvent](file://./../../data/contracts/board.ck#L149)
 */
export const CardEvent = z.strictObject({
    id: z.string(),
    type: z.string(),
    stage: z.string().nullable(),
    payload: _ZodJson,
    createdAt: _ZodDatetime,
});
export type CardEvent = z.infer<typeof CardEvent>;

/**
 * generated from [CardVersion](file://./../../data/contracts/board.ck#L157)
 */
export const CardVersion = z.strictObject({
    id: z.string(),
    message: z.string(),
    createdAt: _ZodDatetime,
});
export type CardVersion = z.infer<typeof CardVersion>;

/**
 * Shared by both history endpoints — a named contract so the generator takes the schema path
 * that honours `?`, rather than the inline `query: { limit?: int }` path that renders it required.
 * generated from [ListQuery](file://./../../data/contracts/board.ck#L165)
 */
export const ListQuery = z.strictObject({
    limit: z.coerce.number().int().optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

/**
 * Card 0077 splits `wilson card plan` into the half that must be local — the interactive `claude`
 * conversation itself, which needs the operator's own terminal — and the half that does not: cutting
 * the throwaway worktree, loading the `planning` stage's model and instructions, validating the
 * finished draft, writing it as a new card version, and tearing the worktree down. This contract is
 * the second half. The API owns the session; the CLI (unchanged until card 0074) will own spawning
 * `claude` with the operator's stdio against what this returns.
 * generated from [PlanSession](file://./../../data/contracts/board.ck#L175)
 */
export const PlanSession = z.strictObject({
    sessionId: z
        .string()
        .describe(
            "Identifies this session for the `save`/`close` calls that follow. Deterministically the card's\nown id, not an opaque token from a session table: the worktree and its branch are always cut\nas `plan-<id>` / a branch keyed off `<id>` (never the card's real path or branch — card 0058's\nguard), so there is exactly one live planning session per card, and opening a new one for the\nsame id is what recovers a session whose CLI died mid-conversation. Carried as its own field\nregardless, so this response names what it is rather than leaving a caller to assume it equals\nthe path param.",
        ),
    worktreePath: z.string().describe('Absolute path to the throwaway worktree the spawned agent should be pointed at.'),
    draftPath: z
        .string()
        .describe(
            "Where the finished plan must be written, and the one file writes to it are allowed against.\nAlready seeded: the card's existing body if it has sections, the six-heading skeleton\notherwise — same seed `wilson card plan` writes today.",
        ),
    model: z.string().describe("The `planning` stage's own model, from `stages.yaml` — never a string this contract pins."),
    instructions: z
        .string()
        .describe(
            "The `planning` stage's own instructions, plus the one fact only this session knows: where the\ndraft lives. Meant to travel as the spawned agent's appended system prompt, with the same\nweight as its base instructions, not as a user turn it might treat as negotiable.",
        ),
});
export type PlanSession = z.infer<typeof PlanSession>;

/**
 * generated from [SaveDraftRequest](file://./../../data/contracts/board.ck#L198)
 */
export const SaveDraftRequest = z.strictObject({
    body: z
        .string()
        .describe(
            'The finished draft\'s full body, six headings included. There is no terminal on the other end\nof an HTTP call for a confirmation prompt — "approval is explicit and versioned" is enforced by\nthe caller showing a diff and asking before this is ever sent, not by this contract.',
        ),
});
export type SaveDraftRequest = z.infer<typeof SaveDraftRequest>;

/**
 * Card 0133: the daemon can hold a planning conversation for a card itself. `POST .../plan/turn`'s
 * request — one message in that conversation.
 * generated from [PlanTurnRequest](file://./../../data/contracts/board.ck#L207)
 */
export const PlanTurnRequest = z.strictObject({
    text: z.string(),
});
export type PlanTurnRequest = z.infer<typeof PlanTurnRequest>;

/**
 * One row of `runner.plan_turns` — a turn in a card's planning conversation, whether this is
 * `POST .../plan/turn`'s response (the just-appended assistant turn) or one of the entries
 * `GET .../plan/stream` replays after a client's `Last-Event-ID`.
 * generated from [PlanTurn](file://./../../data/contracts/board.ck#L214)
 */
export const PlanTurn = z.strictObject({
    seq: z.coerce
        .number()
        .int()
        .describe(
            "`Last-Event-ID`'s resume key: monotonic per card, so a reconnecting client asks for every turn\nwith `seq` greater than the last one it saw.",
        ),
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    createdAt: _ZodDatetime,
});
export type PlanTurn = z.infer<typeof PlanTurn>;

/**
 * Card 0140. `open` writes `draft.md` and hands back its server-local path (`PlanSession.draftPath`)
 * — no use to a browser, which is never on the same filesystem the CLI is (card 0077's split). This
 * is the content a client reads instead: exactly what is on disk, whether that is the seed `open`
 * wrote, a draft the agent is partway through, or the last thing `save` wrote before the session
 * closed. See `PlanService.draft` for what an id with no draft yet gets instead of this.
 * generated from [PlanDraft](file://./../../data/contracts/board.ck#L228)
 */
export const PlanDraft = z.strictObject({
    body: z.string(),
});
export type PlanDraft = z.infer<typeof PlanDraft>;

/**
 * Card 0146. A comment left on a passage of a plan draft — what a person could point at but had
 * nowhere to put. Stores exactly the anchor [[0145]]'s `Anchor` captures — the quote plus its
 * surrounding window — never a resolved position: the draft is rewritten whole on every planning
 * turn, so a stored offset would be wrong by the very next revision. `resolved` is a state a
 * comment moves through, not a delete — a comment the agent addressed stays on record.
 * generated from [PlanComment](file://./../../data/contracts/board.ck#L237)
 */
export const PlanComment = z.strictObject({
    id: z.string(),
    quote: z.string(),
    prefix: z.string(),
    suffix: z.string(),
    text: z.string(),
    resolved: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    createdAt: _ZodDatetime,
});
export type PlanComment = z.infer<typeof PlanComment>;

/**
 * `POST .../plan/comments`'s request — the anchor a client already captured
 * (`captureAnchor`, apps/web/src/lib/anchor.ts) plus what the person said about it.
 * generated from [CreatePlanCommentRequest](file://./../../data/contracts/board.ck#L249)
 */
export const CreatePlanCommentRequest = z.strictObject({
    quote: z.string(),
    prefix: z.string(),
    suffix: z.string(),
    text: z.string(),
});
export type CreatePlanCommentRequest = z.infer<typeof CreatePlanCommentRequest>;

/**
 * Card 0113. One piece of a scope-check refusal's division (see `ScopeDivisionPieceSchema`,
 * apps/api/src/modules/stages/stage.result.ts) — carried over the wire twice: as reported, from
 * `GET .../division`, and again, possibly with `dependsOn` edited, in the body of `POST .../split`.
 * One shape for both directions so a client can round-trip a piece it only meant to touch one field
 * of.
 * generated from [DivisionPiece](file://./../../data/contracts/board.ck#L261)
 */
export const DivisionPiece = z.strictObject({
    title: z.string(),
    tasks: z.array(z.string()),
    delivers: z.string(),
    dependsOn: z
        .array(z.string())
        .describe(
            'Titles of other pieces in the same division this piece\'s own report named as blocking it.\n`ScopeDivisionPieceSchema` defaults this to `[]` whether the model said "independent" or simply\ndid not say — an empty array here is not proof of independence. A client must show this field\nas reported and let an operator add to it before anything is created; it must not try to infer\na missing dependency from `delivers` prose.',
        ),
});
export type DivisionPiece = z.infer<typeof DivisionPiece>;

/**
 * generated from [CardDetail](file://./../../data/contracts/board.ck#L66)
 */
export const CardDetail = CardSummary.extend({
    body: z.string(),
    sections: z.record(z.string(), z.string()),
});
export type CardDetail = z.infer<typeof CardDetail>;

/**
 * `GET /api/cards/{id}/division`'s response: the most recent scope-check refusal on record for a
 * card. Read from the event log, not a fresh run — `scope-check` already happened, and re-running it
 * could return a different division for the cost of a whole pass, which is `scope-check`'s job to
 * spend, not this endpoint's.
 * generated from [CardDivision](file://./../../data/contracts/board.ck#L277)
 */
export const CardDivision = z.strictObject({
    reason: z
        .string()
        .describe(
            'The refusal\'s own stated reason (`ScopeCheckResultSchema.reason`) — repetition, named in the\nmodel\'s own words, not merely "refused".',
        ),
    pieces: z.array(DivisionPiece),
});
export type CardDivision = z.infer<typeof CardDivision>;

/**
 * `POST /api/cards/{id}/split`'s request: every piece to create, exactly as an operator confirmed
 * it — `title`/`tasks`/`delivers` as `scope-check` reported them, `dependsOn` as the operator left it
 * after being shown what was reported and given the chance to add to it. The endpoint does not go
 * back to the event log to re-read the division itself; the confirmed pieces are the only truth it
 * acts on.
 * generated from [SplitCardsRequest](file://./../../data/contracts/board.ck#L289)
 */
export const SplitCardsRequest = z.strictObject({
    pieces: z.array(DivisionPiece),
});
export type SplitCardsRequest = z.infer<typeof SplitCardsRequest>;

/**
 * `BoardWriteService.release`'s response (card 0087): the card, plus which of the two safe-to-cancel
 * cases it took. `queued` is a job in `created` or `retry` — by definition nothing has picked it up,
 * so cancelling it cannot interrupt anything. `orphan` is a job the broker still shows `active` but
 * that this process's own tracking confirms nothing is currently running — left behind by an earlier
 * process that crashed before it could clear or hand off. A job genuinely mid-run stays refused (see
 * the release operation's 400 below) and never reaches this response at all.
 * generated from [ReleaseResult](file://./../../data/contracts/board.ck#L77)
 */
export const ReleaseResult = CardDetail.extend({
    releasedAs: z.enum(['queued', 'orphan']),
});
export type ReleaseResult = z.infer<typeof ReleaseResult>;

/**
 * Card 0143. `POST /api/cards/{id}/merge`'s response: the card, plus what the attempt actually did.
 * A conflict and a suite failure are not bad input — they are two of the three honest outcomes an
 * attempt can have, the same way `ReleaseResult.releasedAs` names which safe-to-cancel case a
 * release was, so both come back as `merged: false` with `reason` in a 200, not a 400. The only
 * thing this operation refuses outright is a card that is not in `ready` (see its 400 below).
 * generated from [MergeResult](file://./../../data/contracts/board.ck#L86)
 */
export const MergeResult = CardDetail.extend({
    merged: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    commit: z.string().optional().describe('The commit `main` now points at, present only when `merged` is true.'),
    reason: z
        .string()
        .optional()
        .describe("Why the attempt did not land — a conflict naming the paths, or the suite's own failure —\npresent only when `merged` is false."),
});
export type MergeResult = z.infer<typeof MergeResult>;

/**
 * `POST /api/cards/{id}/split`'s response: the origin card, re-read after being annotated with the
 * ids it produced, and the cards created from each piece, in the order `pieces` was sent. Every
 * created card lands in `planning`, never `backlog` — a piece is a title, a task list and a
 * sentence, not a plan with all six headings filled in.
 * generated from [SplitResult](file://./../../data/contracts/board.ck#L297)
 */
export const SplitResult = z.strictObject({
    origin: CardDetail,
    pieces: z.array(CardDetail),
});
export type SplitResult = z.infer<typeof SplitResult>;
