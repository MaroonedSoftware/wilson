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
 * generated from [BoardColumns](file://./../../data/contracts/board.ck#L12)
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
 * generated from [CardSummary](file://./../../data/contracts/board.ck#L20)
 */
export const CardSummary = z.strictObject({
    id: z.string(),
    title: z.string(),
    stage: z.string(),
    branch: z.string().optional(),
    dependsOn: z.array(z.string()),
});
export type CardSummary = z.infer<typeof CardSummary>;

/**
 * generated from [CardEvent](file://./../../data/contracts/board.ck#L33)
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
 * generated from [CardVersion](file://./../../data/contracts/board.ck#L41)
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
 * generated from [ListQuery](file://./../../data/contracts/board.ck#L49)
 */
export const ListQuery = z.strictObject({
    limit: z.coerce.number().int().optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

/**
 * generated from [CardDetail](file://./../../data/contracts/board.ck#L28)
 */
export const CardDetail = CardSummary.extend({
    body: z.string(),
    sections: z.record(z.string(), z.string()),
});
export type CardDetail = z.infer<typeof CardDetail>;
