import type { JsonValue } from '../sdk-options.js';

/**
 * The board's columns. They live in `config/stages.yaml` on the board repo, which a browser cannot
 * read — and a board that hard-codes its columns lies the first time a stage is added, which is
 * cheap to do precisely because stages are config.
 * generated from [BoardColumns](file://./../../../../apps/api/data/contracts/board.ck#L20)
 */
export interface BoardColumns {
    /** configured stages, in the order they run */
    stages: string[];
    /** parking-lot and the terminal states */
    nonStages: string[];
}

/**
 * No `position`. `runner.cards` has the column, for ordering the parking lot, but nothing populates
 * it and `Card` does not carry it — so exposing it here would have shipped a field that is absent
 * from every response. It comes back when parking-lot ordering is actually built, with a value.
 * generated from [CardSummary](file://./../../../../apps/api/data/contracts/board.ck#L28)
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
}

/**
 * The write surface. Each request body is its own named contract rather than inlined on the
 * operation, for the same reason `ListQuery` is one: contractkit only honours a field's `?` down
 * the schema path a named type takes, and every one of card 0080's five mutations copies this shape.
 *
 * `id` never appears in a request body — it is either a path param (move, edit act on a card that
 * already exists) or, for create, assigned by the service the same way `wilson card create` assigns
 * it: the next sequential id over the current board. A client cannot pick one.
 * generated from [CreateCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L52)
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
 * generated from [MoveCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L62)
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
 * generated from [EditCardRequest](file://./../../../../apps/api/data/contracts/board.ck#L69)
 */
export interface EditCardRequest {
    body: string;
}

/**
 * generated from [CardEvent](file://./../../../../apps/api/data/contracts/board.ck#L73)
 */
export interface CardEvent {
    id: string;
    type: string;
    stage: string | null;
    payload: JsonValue;
    createdAt: string;
}

/**
 * generated from [CardVersion](file://./../../../../apps/api/data/contracts/board.ck#L81)
 */
export interface CardVersion {
    id: string;
    message: string;
    createdAt: string;
}

/**
 * Shared by both history endpoints — a named contract so the generator takes the schema path
 * that honours `?`, rather than the inline `query: { limit?: int }` path that renders it required.
 * generated from [ListQuery](file://./../../../../apps/api/data/contracts/board.ck#L89)
 */
export interface ListQuery {
    limit?: number;
}

/**
 * generated from [CardDetail](file://./../../../../apps/api/data/contracts/board.ck#L40)
 */
export interface CardDetail extends CardSummary {
    body: string;
    sections: Record<string, string>;
}
