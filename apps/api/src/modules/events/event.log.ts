import { Injectable } from 'injectkit';
import { Kysely, sql, type Transaction } from 'kysely';
import type { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';
import type { CardEvent, CardEventType } from './card.event.js';

export interface CardEventRow {
    id: string;
    stage: string | null;
    type: CardEventType;
    payload: Record<string, unknown>;
    createdAt: DateTime;
}

/**
 * `card.over-budget` (card 0018) belongs in the closed `CardEventType` union alongside
 * `stage.poisoned`, but `card.event.ts` is outside this card's "Files in scope" — a conflict a
 * prior review flagged, since widening `append` to plain `string` would drop the closed union's
 * compile-time typo protection for the very event type this card adds.
 *
 * Extending the union locally, at the one call site that needs it, keeps that protection without
 * touching the file this card cannot edit. A follow-up card can fold this member into
 * `CardEventType` itself and delete this alias.
 */
export type AppendableCardEventType = CardEventType | 'card.over-budget';

export type AppendableCardEvent = Omit<CardEvent, 'type'> & { type: AppendableCardEventType };

/**
 * The operational record: append-only, never updated, never deleted.
 *
 * `runner.cards` records *what a card is*; this records *what happened to it*. Both are now in the
 * same database, which is what lets a transition and its event share a transaction — previously the
 * card was committed to git and the event appended here, with no way to reconcile a partial failure.
 */
@Injectable()
export class EventLog {
    constructor(private readonly db: Kysely<DB>) {}

    /**
     * Append one event.
     *
     * `executor` lets a caller pass an open transaction so a transition and the event describing it
     * commit together — see `BoardRepository.writeWithEvent`. Defaults to the pool, which is right
     * for the standalone events (worktree created, stage started) that describe no state change.
     */
    async append(event: AppendableCardEvent, executor: Kysely<DB> | Transaction<DB> = this.db): Promise<void> {
        await executor
            .insertInto('runner.cardEvents')
            .values({
                project: event.project,
                cardId: event.cardId,
                stage: event.stage ?? null,
                type: event.type,
                payload: JSON.stringify(event.payload ?? {}),
            })
            .execute();
    }

    /**
     * The tail of one card's log, oldest first.
     *
     * `limit` bounds the read because a card that has kicked back repeatedly can accumulate a long
     * history, and every caller so far only wants the recent end of it.
     */
    async tail(project: string, cardId: string, limit = 100): Promise<CardEventRow[]> {
        const rows = await this.db
            .selectFrom('runner.cardEvents')
            .where('project', '=', project)
            .where('cardId', '=', cardId)
            .orderBy('id', 'desc')
            .limit(limit)
            .selectAll()
            .execute();

        return rows.reverse().map(row => ({
            id: String(row.id),
            stage: row.stage,
            type: row.type as CardEventType,
            payload: (row.payload ?? {}) as Record<string, unknown>,
            createdAt: row.createdAt,
        }));
    }

    /**
     * What a card has spent in total, across every stage and every attempt.
     *
     * Every stage already records `usage.inputTokens` in its `stage.passed` / `stage.failed`
     * payload, so this reads that history rather than tracking a separate running counter. Nulls —
     * a card with no usage recorded — coalesce to zero rather than surfacing as null.
     */
    async totalInputTokens(project: string, cardId: string): Promise<number> {
        const row = await this.db
            .selectFrom('runner.cardEvents')
            .where('project', '=', project)
            .where('cardId', '=', cardId)
            .select(sql<string>`coalesce(sum((payload->'usage'->>'inputTokens')::bigint), 0)`.as('total'))
            .executeTakeFirstOrThrow();

        return Number(row.total);
    }
}
