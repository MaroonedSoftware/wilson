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
 * generated from [BoardColumns](file://./../../data/contracts/board.ck#L21)
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
 * generated from [CardSummary](file://./../../data/contracts/board.ck#L29)
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
 * generated from [CreateCardRequest](file://./../../data/contracts/board.ck#L53)
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
 * generated from [MoveCardRequest](file://./../../data/contracts/board.ck#L63)
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
 * generated from [EditCardRequest](file://./../../data/contracts/board.ck#L70)
 */
export const EditCardRequest = z.strictObject({
    body: z.string(),
});
export type EditCardRequest = z.infer<typeof EditCardRequest>;

/**
 * generated from [DependCardRequest](file://./../../data/contracts/board.ck#L74)
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
 * generated from [CardEvent](file://./../../data/contracts/board.ck#L81)
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
 * generated from [CardVersion](file://./../../data/contracts/board.ck#L89)
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
 * generated from [ListQuery](file://./../../data/contracts/board.ck#L97)
 */
export const ListQuery = z.strictObject({
    limit: z.coerce.number().int().optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

/**
 * Bootstrap: scaffolding and importing the board itself, not a card. Both operate on
 * `BoardConfig.boardRoot` — the path is server configuration, never a request field, so an endpoint
 * here is not a remote write-anywhere-on-disk primitive (card 0076).
 * generated from [ImportBoardRequest](file://./../../data/contracts/board.ck#L104)
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
 * generated from [ImportReport](file://./../../data/contracts/board.ck#L110)
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
 * generated from [CardDetail](file://./../../data/contracts/board.ck#L41)
 */
export const CardDetail = CardSummary.extend({
    body: z.string(),
    sections: z.record(z.string(), z.string()),
});
export type CardDetail = z.infer<typeof CardDetail>;
