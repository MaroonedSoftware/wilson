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
 * The board's columns. They live in `config/stages.yaml` on the board repo, which a browser cannot
 * read — and a board that hard-codes its columns lies the first time a stage is added, which is
 * cheap to do precisely because stages are config.
 * generated from [BoardColumns](file://./../../data/contracts/board.ck#L22)
 */
export const BoardColumns = z.strictObject({
    stages: z.array(z.string()).describe('configured stages, in the order they run'),
    nonStages: z.array(z.string()).describe('parking-lot and the terminal states'),
});
export type BoardColumns = z.infer<typeof BoardColumns>;

/**
 * No `position`. `runner.cards` has the column, for ordering the parking lot, but nothing populates
 * it and `Card` does not carry it — so exposing it here would have shipped a field that is absent
 * from every response. It comes back when parking-lot ordering is actually built, with a value.
 * generated from [CardSummary](file://./../../data/contracts/board.ck#L30)
 */
export const CardSummary = z.strictObject({
    id: z.string(),
    title: z.string(),
    stage: z.string(),
    branch: z.string().optional(),
    dependsOn: z.array(z.string()),
    needsHuman: z
        .preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
        .describe(
            'Required, unlike the frontmatter\'s optional `needsHuman?`, so the web never has to write\n`?? false` — every card has an answer to "does this need a human", even if that answer is no.',
        ),
    needsHumanReason: z.string().optional(),
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
 * generated from [CreateCardRequest](file://./../../data/contracts/board.ck#L64)
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
 * generated from [MoveCardRequest](file://./../../data/contracts/board.ck#L74)
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
 * generated from [EditCardRequest](file://./../../data/contracts/board.ck#L81)
 */
export const EditCardRequest = z.strictObject({
    body: z.string(),
});
export type EditCardRequest = z.infer<typeof EditCardRequest>;

/**
 * generated from [DependCardRequest](file://./../../data/contracts/board.ck#L85)
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
 * generated from [CardEvent](file://./../../data/contracts/board.ck#L92)
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
 * generated from [CardVersion](file://./../../data/contracts/board.ck#L100)
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
 * generated from [ListQuery](file://./../../data/contracts/board.ck#L108)
 */
export const ListQuery = z.strictObject({
    limit: z.coerce.number().int().optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

/**
 * Bootstrap: scaffolding and importing the board itself, not a card. Both operate on
 * `BoardConfig.boardRoot` — the path is server configuration, never a request field, so an endpoint
 * here is not a remote write-anywhere-on-disk primitive (card 0076).
 * generated from [ImportBoardRequest](file://./../../data/contracts/board.ck#L115)
 */
export const ImportBoardRequest = z.strictObject({
    dryRun: z
        .preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
        .optional()
        .describe(
            'Report what would happen without writing anything — the one affordance that makes a one-shot,\nirreversible import safe to attempt. Absent (the default) writes.',
        ),
});
export type ImportBoardRequest = z.infer<typeof ImportBoardRequest>;

/**
 * generated from [ImportReport](file://./../../data/contracts/board.ck#L121)
 */
export const ImportReport = z.strictObject({
    cards: z.coerce.number().int(),
    dependencies: z.coerce.number().int(),
    unpinned: z
        .array(z.string())
        .describe(
            'Ids whose legacy `planSha` could not map to a version in the imported history, and were\nre-pinned to the version this import created instead.',
        ),
    skipped: z
        .preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
        .describe('True for a dry run: nothing above was written, this is a preview.'),
});
export type ImportReport = z.infer<typeof ImportReport>;

/**
 * Card 0077 splits `wilson card plan` into the half that must be local — the interactive `claude`
 * conversation itself, which needs the operator's own terminal — and the half that does not: cutting
 * the throwaway worktree, loading the `planning` stage's model and instructions, validating the
 * finished draft, writing it as a new card version, and tearing the worktree down. This contract is
 * the second half. The API owns the session; the CLI (unchanged until card 0074) will own spawning
 * `claude` with the operator's stdio against what this returns.
 * generated from [PlanSession](file://./../../data/contracts/board.ck#L137)
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
 * generated from [SaveDraftRequest](file://./../../data/contracts/board.ck#L160)
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
 * Card 0113. One piece of a scope-check refusal's division (see `ScopeDivisionPieceSchema`,
 * apps/api/src/modules/stages/stage.result.ts) — carried over the wire twice: as reported, from
 * `GET .../division`, and again, possibly with `dependsOn` edited, in the body of `POST .../split`.
 * One shape for both directions so a client can round-trip a piece it only meant to touch one field
 * of.
 * generated from [DivisionPiece](file://./../../data/contracts/board.ck#L172)
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
 * generated from [CardDetail](file://./../../data/contracts/board.ck#L42)
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
 * generated from [CardDivision](file://./../../data/contracts/board.ck#L188)
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
 * generated from [SplitCardsRequest](file://./../../data/contracts/board.ck#L200)
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
 * generated from [ReleaseResult](file://./../../data/contracts/board.ck#L53)
 */
export const ReleaseResult = CardDetail.extend({
    releasedAs: z.enum(['queued', 'orphan']),
});
export type ReleaseResult = z.infer<typeof ReleaseResult>;

/**
 * `POST /api/cards/{id}/split`'s response: the origin card, re-read after being annotated with the
 * ids it produced, and the cards created from each piece, in the order `pieces` was sent. Every
 * created card lands in `planning`, never `backlog` — a piece is a title, a task list and a
 * sentence, not a plan with all six headings filled in.
 * generated from [SplitResult](file://./../../data/contracts/board.ck#L208)
 */
export const SplitResult = z.strictObject({
    origin: CardDetail,
    pieces: z.array(CardDetail),
});
export type SplitResult = z.infer<typeof SplitResult>;
