import type { JsonValue } from '../sdk-options.js';

/**
 * The board's columns. They live in `config/stages.yaml` on the board repo, which a browser cannot
 * read — and a board that hard-codes its columns lies the first time a stage is added, which is
 * cheap to do precisely because stages are config.
 * generated from [BoardColumns](file://./../../../../apps/api/data/contracts/board.ck#L12)
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
 * generated from [CardSummary](file://./../../../../apps/api/data/contracts/board.ck#L20)
 */
export interface CardSummary {
    id: string;
    title: string;
    stage: string;
    branch?: string;
    dependsOn: string[];
}

/**
 * generated from [CardEvent](file://./../../../../apps/api/data/contracts/board.ck#L33)
 */
export interface CardEvent {
    id: string;
    type: string;
    stage: string | null;
    payload: JsonValue;
    createdAt: string;
}

/**
 * generated from [CardVersion](file://./../../../../apps/api/data/contracts/board.ck#L41)
 */
export interface CardVersion {
    id: string;
    message: string;
    createdAt: string;
}

/**
 * Shared by both history endpoints — a named contract so the generator takes the schema path
 * that honours `?`, rather than the inline `query: { limit?: int }` path that renders it required.
 * generated from [ListQuery](file://./../../../../apps/api/data/contracts/board.ck#L49)
 */
export interface ListQuery {
    limit?: number;
}

/**
 * generated from [CardDetail](file://./../../../../apps/api/data/contracts/board.ck#L28)
 */
export interface CardDetail extends CardSummary {
    body: string;
    sections: Record<string, string>;
}
