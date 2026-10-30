import { Injectable } from 'injectkit';
import { Kysely, sql, type Transaction } from 'kysely';
import type { DateTime } from 'luxon';
import { Logger } from '@maroonedsoftware/logger';
import type { DB } from '#modules/data/db.js';
import { CARD_FEED_CHANNEL } from '#modules/feed/card.feed.js';
import type { CardEvent, CardEventType } from './card.event.js';

export interface CardEventRow {
    id: string;
    stage: string | null;
    type: CardEventType;
    payload: Record<string, unknown>;
    createdAt: DateTime;
}

/** One stage's share of {@link CardUsage} — see {@link EventLog.usageByStage}. */
export interface CardStageUsage {
    stage: string;
    attempts: number;
    inputTokens: number;
    outputTokens: number;
}

/** What a card cost, per stage and in total — see {@link EventLog.usageByStage}. */
export interface CardUsage {
    total: { attempts: number; inputTokens: number; outputTokens: number };
    stages: CardStageUsage[];
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
 * `wilson.cards` records *what a card is*; this records *what happened to it*. Both are now in the
 * same database, which is what lets a transition and its event share a transaction — previously the
 * card was committed to git and the event appended here, with no way to reconcile a partial failure.
 */
@Injectable()
export class EventLog {
    constructor(
        private readonly db: Kysely<DB>,
        private readonly logger: Logger,
    ) {}

    /**
     * Append one event.
     *
     * `executor` lets a caller pass an open transaction so a transition and the event describing it
     * commit together — see `BoardRepository.writeWithEvent`. Defaults to the pool, which is right
     * for the standalone events (worktree created, stage started) that describe no state change.
     */
    async append(event: AppendableCardEvent, executor: Kysely<DB> | Transaction<DB> = this.db): Promise<void> {
        const row = await executor
            .insertInto('wilson.cardEvents')
            .values({
                project: event.project,
                cardId: event.cardId,
                stage: event.stage ?? null,
                type: event.type,
                payload: JSON.stringify(event.payload ?? {}),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
        // `id` is BIGSERIAL; the driver hands back a BigInt despite `Generated<string>` — see
        // `postgres.board.repository.ts`'s `versionId`. Stringify before it reaches `JSON.stringify`
        // below, which throws on a raw BigInt.
        const id = String(row.id);

        // Publish on the same executor that did the insert. Postgres queues a `NOTIFY` issued
        // inside a transaction and only delivers it once that transaction commits, discarding it
        // on rollback — exactly "publish after commit, not inside it" for `writeWithEvent`'s open
        // transaction, with no in-process commit tracking needed. For a standalone event (the
        // pool default) the insert already commits on its own, so the notify goes out right away.
        // See `modules/feed/card.feed.listener.ts` for the subscriber on the other end.
        //
        // The notification carries the event's identity — which row, on which card — and not its
        // contents. Postgres caps a NOTIFY payload at 8000 bytes and raises `payload string too
        // long` past it, which used to fail the whole append — including, inside
        // `writeWithEvent`'s transaction, the insert and the transition it was recording. A
        // `stage.passed` event carries the agent's entire structured result, so a verbose stage
        // exceeded this on its own: card 0105's implementing pass committed its work, then lost the
        // transition to this and began re-running the stage on every queue retry. The row itself is
        // JSONB and has no such limit, so the fix is to stop putting the payload on the wire at all:
        // `pg_notify` exists to wake the subscriber, and the subscriber has a database connection
        // and can read the row it was told about. `project`/`cardId`/`stage`/`type` stay in the
        // envelope — they are always small and fixed-shape, unlike `payload` — so the subscriber
        // (and anything watching the raw channel, like this file's tests) can identify an event
        // without a round trip; only `id`, for fetching the payload itself, is new.
        //
        // A failure to notify must not cost the append. For the pool-default executor the insert has
        // already committed by the time we get here, so there is nothing left to lose. Inside an open
        // transaction, a genuine error from this statement would still abort it the same as any other
        // query would — catching it here cannot rescue that, and does not need to: the envelope below
        // is a small, fixed-shape identity object, never the caller-controlled payload, so it can no
        // longer reproduce the failure this card exists to fix. What this guards against is
        // everything else that can go wrong announcing an id (a dropped connection, a full-of-other-
        // problems channel), none of which should turn into a lost card transition.
        const envelope = {
            project: event.project,
            cardId: event.cardId,
            stage: event.stage ?? null,
            type: event.type,
            id,
        };
        try {
            await sql`select pg_notify(${CARD_FEED_CHANNEL}, ${JSON.stringify(envelope)})`.execute(executor);
        } catch (err) {
            this.logger.error(err);
        }
    }

    /**
     * The tail of one card's log, oldest first.
     *
     * `limit` bounds the read because a card that has kicked back repeatedly can accumulate a long
     * history, and every caller so far only wants the recent end of it.
     */
    async tail(project: string, cardId: string, limit = 100): Promise<CardEventRow[]> {
        const rows = await this.db
            .selectFrom('wilson.cardEvents')
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
            .selectFrom('wilson.cardEvents')
            .where('project', '=', project)
            .where('cardId', '=', cardId)
            .select(sql<string>`coalesce(sum((payload->'usage'->>'inputTokens')::bigint), 0)`.as('total'))
            .executeTakeFirstOrThrow();

        return Number(row.total);
    }

    /**
     * What a card cost, per stage and in total — for reading, not billing. Every stage on this
     * board runs through the subscription-billed `cli` adapter, which reports no `total_cost_usd`
     * (card 0263's Constraints); these are token counts, and a subscription run's tokens are not a
     * price.
     *
     * One grouped query over `stage.passed`/`stage.failed` rows, keyed by `stage`. `stages` comes
     * back in the order each stage was first run — `min(id)` ascending, since `id` is a `BIGSERIAL`
     * assigned in insertion order (`append`) — not alphabetically. An event whose payload has no
     * `usage` still counts as an attempt, at zero tokens, so `attempts` can never disagree with what
     * `tail` shows for the same card: nothing here is silently skipped.
     */
    async usageByStage(project: string, cardId: string): Promise<CardUsage> {
        const rows = await this.db
            .selectFrom('wilson.cardEvents')
            .where('project', '=', project)
            .where('cardId', '=', cardId)
            .where('type', 'in', ['stage.passed', 'stage.failed'])
            .select([
                'stage',
                sql<string>`count(*)`.as('attempts'),
                sql<string>`coalesce(sum((payload->'usage'->>'inputTokens')::bigint), 0)`.as('inputTokens'),
                sql<string>`coalesce(sum((payload->'usage'->>'outputTokens')::bigint), 0)`.as('outputTokens'),
                sql<string>`min(id)`.as('firstId'),
            ])
            .groupBy('stage')
            .orderBy('firstId', 'asc')
            .execute();

        const stages: CardStageUsage[] = rows.map(row => ({
            stage: row.stage ?? '',
            attempts: Number(row.attempts),
            inputTokens: Number(row.inputTokens),
            outputTokens: Number(row.outputTokens),
        }));

        const total = stages.reduce(
            (acc, stage) => ({
                attempts: acc.attempts + stage.attempts,
                inputTokens: acc.inputTokens + stage.inputTokens,
                outputTokens: acc.outputTokens + stage.outputTokens,
            }),
            { attempts: 0, inputTokens: 0, outputTokens: 0 },
        );

        return { total, stages };
    }

    /**
     * What a project has spent in output tokens since a given instant — card 0264's rollup, beside
     * `usageByStage`'s per-card one, that a daily ceiling is checked against. Same
     * `stage.passed`/`stage.failed` rows, summed across every card in the project rather than grouped
     * by one card's stages, and only `outputTokens`: the ceiling this backs is output-only for the
     * reason `DAILY_OUTPUT_TOKEN_CEILING`'s own doc comment gives, and there is no per-stage grouping
     * to preserve here the way `usageByStage` needs one. An event with no `usage` still coalesces to
     * zero rather than being skipped, the same as `usageByStage`; every event type other than the two
     * named never carries a `usage` payload, so restricting to them is about legible intent, not
     * correctness `usageByStage` didn't already need to state outright.
     *
     * `since` is compared straight against `createdAt` — a caller means whatever zone it computed
     * `since` in, and this does no conversion of its own. `createdAt` is stored in UTC (this table's
     * own doc comment), so a caller after "today" in its own local zone, not UTC's, must pass local
     * midnight, not `since.toUTC()`'s midnight — `Poller`/`BoardWriteService.start` do exactly that.
     */
    async outputTokensSince(project: string, since: DateTime): Promise<number> {
        const row = await this.db
            .selectFrom('wilson.cardEvents')
            .where('project', '=', project)
            .where('type', 'in', ['stage.passed', 'stage.failed'])
            .where('createdAt', '>=', since)
            .select(sql<string>`coalesce(sum((payload->'usage'->>'outputTokens')::bigint), 0)`.as('total'))
            .executeTakeFirstOrThrow();

        return Number(row.total);
    }
}
