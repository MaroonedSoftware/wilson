import { Injectable } from 'injectkit';
import { Kysely, sql, type Transaction } from 'kysely';
import type { DateTime } from 'luxon';
import { Logger } from '@maroonedsoftware/logger';
import { budgetedInputTokens } from '#modules/agent/budget.js';
import type { DB } from '#modules/data/db.js';
import { EVAL_RUN_ID_PREFIX } from '#modules/evals/eval.run.id.js';
import { CARD_FEED_CHANNEL } from '#modules/feed/card.feed.js';
import type { ProjectConversationStats, ProjectGateStats, ProjectStageStats, ProjectStats, ProjectStatsCounts } from '../../generated/board.js';
import type { CardEvent, CardEventType } from './card.event.js';
import { foldGateStats, type GateEventRow } from './gate.stats.js';

export interface CardEventRow {
    id: string;
    stage: string | null;
    type: CardEventType;
    payload: Record<string, unknown>;
    createdAt: DateTime;
}

/** One row of {@link EventLog.recent}: a {@link CardEventRow}, plus which card it happened to. */
export interface ActivityRow extends CardEventRow {
    cardId: string;
    /** Absent when the card no longer exists: `wilson.card_events` has no foreign key to it. */
    cardTitle?: string;
}

/**
 * Left out of {@link EventLog.recent}. A stage writes these by the hundred, and `LiveActivity` already
 * shows them on the card's own page. An exclusion list, so an event type added later is shown by
 * default.
 */
const QUIET_ACTIVITY_TYPES: CardEventType[] = ['tool.executed', 'tool.denied', 'tool.unguarded', 'stage.engine-session'];

/** One stage's share of {@link CardUsage} — see {@link EventLog.usageByStage}. */
export interface CardStageUsage {
    stage: string;
    attempts: number;
    inputTokens: number;
    /** How many of `inputTokens` were cached, not an addition to it. */
    cachedInputTokens: number;
    outputTokens: number;
}

/** What a card cost, per stage and in total — see {@link EventLog.usageByStage}. */
export interface CardUsage {
    total: { attempts: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
    stages: CardStageUsage[];
}

/** How many cards {@link EventLog.projectStats} names. */
const TOP_CARDS = 10;

/** Every event {@link EventLog.gateStats} folds. */
const GATE_EVENT_TYPES: AppendableCardEventType[] = [
    'stage.passed',
    'stage.failed',
    'stage.blocked',
    'transition.written',
    'card.answered',
    'card.acked',
    'card.over-budget',
    'context.overflow',
    'rebase.conflict',
    'stage.poisoned',
    'stage.dead',
];

const noCounts = (): ProjectStatsCounts => ({
    attempts: 0,
    passed: 0,
    failed: 0,
    interrupted: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
});

const addCounts = (into: ProjectStatsCounts, counts: ProjectStatsCounts): void => {
    into.attempts += counts.attempts;
    into.passed += counts.passed;
    into.failed += counts.failed;
    into.interrupted += counts.interrupted;
    into.inputTokens += counts.inputTokens;
    into.cachedInputTokens += counts.cachedInputTokens;
    into.outputTokens += counts.outputTokens;
};

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
     * What is happening across a whole project, newest first. `before` is an event id: only events
     * older than it come back, which is how a reader pages further into the history.
     */
    async recent(project: string, limit = 100, before?: number): Promise<ActivityRow[]> {
        let query = this.db
            .selectFrom('wilson.cardEvents as event')
            .leftJoin('wilson.cards as card', join => join.onRef('card.project', '=', 'event.project').onRef('card.id', '=', 'event.cardId'))
            .where('event.project', '=', project)
            .where('event.type', 'not in', QUIET_ACTIVITY_TYPES)
            .where('event.cardId', 'not like', `${EVAL_RUN_ID_PREFIX}%`)
            .orderBy('event.id', 'desc')
            .limit(limit)
            .select(['event.id', 'event.cardId', 'card.title as cardTitle', 'event.stage', 'event.type', 'event.payload', 'event.createdAt']);
        if (before !== undefined) query = query.where('event.id', '<', BigInt(before));

        const rows = await query.execute();
        return rows.map(row => ({
            id: String(row.id),
            cardId: row.cardId,
            cardTitle: row.cardTitle ?? undefined,
            stage: row.stage,
            type: row.type as CardEventType,
            payload: (row.payload ?? {}) as Record<string, unknown>,
            createdAt: row.createdAt,
        }));
    }

    /**
     * What a card has spent against its budget, across every stage and every attempt, weighted as
     * `budgetedInputTokens` weights one run. The raw figures are summed first, so the weights live in
     * that one function. Events from before `cacheWriteInputTokens` was recorded count their whole
     * cached figure as reads, and events from before `cachedInputTokens` count only what they hold.
     *
     * Every stage already records `usage` in its `stage.passed` / `stage.failed`
     * payload, so this reads that history rather than tracking a separate running counter. Nulls —
     * a card with no usage recorded — coalesce to zero rather than surfacing as null.
     */
    async budgetedInputTokens(project: string, cardId: string): Promise<number> {
        const row = await this.db
            .selectFrom('wilson.cardEvents')
            .where('project', '=', project)
            .where('cardId', '=', cardId)
            .select([
                sql<string>`coalesce(sum((payload->'usage'->>'inputTokens')::bigint), 0)`.as('inputTokens'),
                sql<string>`coalesce(sum((payload->'usage'->>'cachedInputTokens')::bigint), 0)`.as('cachedInputTokens'),
                sql<string>`coalesce(sum((payload->'usage'->>'cacheWriteInputTokens')::bigint), 0)`.as('cacheWriteInputTokens'),
            ])
            .executeTakeFirstOrThrow();

        return (
            budgetedInputTokens({
                inputTokens: Number(row.inputTokens),
                cachedInputTokens: Number(row.cachedInputTokens),
                cacheWriteInputTokens: Number(row.cacheWriteInputTokens),
            }) ?? 0
        );
    }

    /**
     * What a card cost, per stage and in total — for reading, not billing. Every stage on this
     * board runs through the subscription-billed `cli` adapter, which reports no `total_cost_usd`
     * (card 0263's Constraints); these are token counts, and a subscription run's tokens are not a
     * price.
     *
     * One grouped query over `stage.passed`/`stage.failed`/`stage.interrupted`/`stage.blocked` rows, keyed by `stage`,
     * plus `rule.verdicts` and `rule.proposed`: what those spent for a stage counts as that stage's, and as no attempt.
     * `stages` comes back in the order each stage was first run — `min(id)` ascending, since `id` is a
     * `BIGSERIAL` assigned in insertion order (`append`) — not alphabetically. An interrupted or blocked run spent
     * its tokens but ended in no verdict and spends no retry, so it adds to the token sums and not to
     * `attempts`; a stage interrupted every time so far has a row with no attempts. A passed or failed
     * event whose payload has no `usage` still counts as an attempt, at zero tokens, so `attempts` can
     * never disagree with what `tail` shows for the same card: nothing here is silently skipped.
     * `inputTokens` includes cached tokens and `cachedInputTokens` says how many of them those are.
     * These are raw tokens: a card's budget weights them (`budgetedInputTokens`), so the two differ.
     */
    async usageByStage(project: string, cardId: string): Promise<CardUsage> {
        const rows = await this.db
            .selectFrom('wilson.cardEvents')
            .where('project', '=', project)
            .where('cardId', '=', cardId)
            .where('type', 'in', ['stage.passed', 'stage.failed', 'stage.interrupted', 'stage.blocked', 'rule.verdicts', 'rule.proposed'])
            .select([
                'stage',
                sql<string>`count(*) filter (where type in ('stage.passed', 'stage.failed'))`.as('attempts'),
                sql<string>`coalesce(sum(coalesce((payload->'usage'->>'inputTokens')::bigint, 0) + coalesce((payload->'usage'->>'cachedInputTokens')::bigint, 0)), 0)`.as(
                    'inputTokens',
                ),
                sql<string>`coalesce(sum((payload->'usage'->>'cachedInputTokens')::bigint), 0)`.as('cachedInputTokens'),
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
            cachedInputTokens: Number(row.cachedInputTokens),
            outputTokens: Number(row.outputTokens),
        }));

        const total = stages.reduce(
            (acc, stage) => ({
                attempts: acc.attempts + stage.attempts,
                inputTokens: acc.inputTokens + stage.inputTokens,
                cachedInputTokens: acc.cachedInputTokens + stage.cachedInputTokens,
                outputTokens: acc.outputTokens + stage.outputTokens,
            }),
            { attempts: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        );

        return { total, stages };
    }

    /**
     * What a project spent and how its stages went from `since` up to `until`, for reading: the same
     * events and the same rules as {@link usageByStage}, across every card. Days are counted in
     * `since`'s own zone, and every day from `since` to `until` is in the result, so a quiet day reads
     * as zero rather than as missing.
     *
     * One grouped query, one row per day, stage and card, folded into each view here, so that the
     * totals, the stages, the days and the cards are all sums of the same rows and cannot disagree.
     * `conversations` is read from the turn tables instead, since those turns are not events.
     */
    async projectStats(project: string, since: DateTime, until: DateTime): Promise<ProjectStats> {
        const zone = since.zoneName ?? 'UTC';
        const conversations = await this.conversationStats(project, since, until);
        const rows = await this.db
            .selectFrom('wilson.cardEvents as event')
            .leftJoin('wilson.cards as card', join => join.onRef('card.project', '=', 'event.project').onRef('card.id', '=', 'event.cardId'))
            .where('event.project', '=', project)
            .where('event.type', 'in', ['stage.passed', 'stage.failed', 'stage.interrupted', 'stage.blocked', 'rule.verdicts', 'rule.proposed'])
            .where('event.createdAt', '>=', since)
            .where('event.createdAt', '<', until)
            .select([
                'event.stage',
                'event.cardId',
                'card.title as cardTitle',
                sql<string>`to_char(event.created_at at time zone ${zone}, 'YYYY-MM-DD')`.as('day'),
                sql<string>`count(*) filter (where event.type = 'stage.passed')`.as('passed'),
                sql<string>`count(*) filter (where event.type = 'stage.failed')`.as('failed'),
                sql<string>`count(*) filter (where event.type = 'stage.interrupted')`.as('interrupted'),
                sql<string>`coalesce(sum(coalesce((event.payload->'usage'->>'inputTokens')::bigint, 0) + coalesce((event.payload->'usage'->>'cachedInputTokens')::bigint, 0)), 0)`.as(
                    'inputTokens',
                ),
                sql<string>`coalesce(sum((event.payload->'usage'->>'cachedInputTokens')::bigint), 0)`.as('cachedInputTokens'),
                sql<string>`coalesce(sum((event.payload->'usage'->>'outputTokens')::bigint), 0)`.as('outputTokens'),
                sql<string>`min(event.id)`.as('firstId'),
            ])
            .groupBy(['day', 'event.stage', 'event.cardId', 'card.title'])
            .orderBy('firstId', 'asc')
            .execute();

        const total = noCounts();
        const stages = new Map<string, ProjectStatsCounts & { cardIds: Set<string> }>();
        const cards = new Map<string, ProjectStatsCounts & { cardTitle?: string }>();
        const days = new Map<string, ProjectStatsCounts>();

        for (let day = since.startOf('day'); day < until; day = day.plus({ days: 1 })) {
            days.set(day.toFormat('yyyy-MM-dd'), noCounts());
        }

        for (const row of rows) {
            const passed = Number(row.passed);
            const failed = Number(row.failed);
            const counts: ProjectStatsCounts = {
                attempts: passed + failed,
                passed,
                failed,
                interrupted: Number(row.interrupted),
                inputTokens: Number(row.inputTokens),
                cachedInputTokens: Number(row.cachedInputTokens),
                outputTokens: Number(row.outputTokens),
            };
            const stageName = row.stage ?? '';
            const stage = stages.get(stageName) ?? { ...noCounts(), cardIds: new Set<string>() };
            stages.set(stageName, stage);
            const card = cards.get(row.cardId) ?? { ...noCounts(), ...(row.cardTitle ? { cardTitle: row.cardTitle } : {}) };
            cards.set(row.cardId, card);
            const day = days.get(row.day) ?? noCounts();
            days.set(row.day, day);

            addCounts(total, counts);
            addCounts(stage, counts);
            addCounts(card, counts);
            addCounts(day, counts);
            stage.cardIds.add(row.cardId);
        }

        return {
            since,
            until,
            zone,
            total: { ...total, cards: cards.size },
            stages: [...stages].map(([stage, { cardIds, ...counts }]): ProjectStageStats => ({ stage, cards: cardIds.size, ...counts })),
            days: [...days].map(([date, counts]) => ({ date, ...counts })),
            topCards: [...cards]
                .map(([cardId, counts]) => ({ cardId, ...counts }))
                .sort((a, b) => b.outputTokens - a.outputTokens || b.inputTokens - a.inputTokens || a.cardId.localeCompare(b.cardId))
                .slice(0, TOP_CARDS),
            conversations,
        };
    }

    /**
     * What the gates caught from `since` up to `until`, and how often a person was pulled in. Reads only
     * the fields it folds out of each `payload`, in `foldGateStats`, since a run's whole payload is large.
     * Rule verdicts are grouped here instead, as one event holds many.
     */
    async gateStats(project: string, since: DateTime, until: DateTime): Promise<ProjectGateStats> {
        const [rows, rules] = await Promise.all([
            this.db
                .selectFrom('wilson.cardEvents as event')
                .where('event.project', '=', project)
                .where('event.type', 'in', GATE_EVENT_TYPES)
                .where('event.createdAt', '>=', since)
                .where('event.createdAt', '<', until)
                .select([
                    'event.cardId',
                    'event.stage',
                    'event.type',
                    sql<string | null>`event.payload->>'step'`.as('step'),
                    sql<string | null>`event.payload->'result'->>'verdict'`.as('verdict'),
                    sql<string | null>`event.payload->>'failureClass'`.as('failureClass'),
                    sql<string | null>`event.payload->>'error'`.as('error'),
                    sql<string | null>`event.payload->'failures'->>0`.as('firstFailure'),
                    sql<boolean | null>`(event.payload->>'loopStopped')::boolean`.as('loopStopped'),
                    sql<boolean | null>`(event.payload->>'alreadyResolved')::boolean`.as('alreadyResolved'),
                    sql<string | null>`event.payload->>'from'`.as('from'),
                    sql<string | null>`event.payload->>'to'`.as('to'),
                    sql<string | null>`event.payload->>'by'`.as('by'),
                    sql<boolean | null>`(event.payload->>'needsHuman')::boolean`.as('needsHuman'),
                    sql<string | null>`event.payload->>'reason'`.as('reason'),
                    sql<GateEventRow['retries']>`event.payload->'retries'`.as('retries'),
                ])
                .orderBy('event.id', 'asc')
                .execute(),
            this.db
                .selectFrom('wilson.cardEvents as event')
                .innerJoinLateral(
                    eb =>
                        eb
                            .selectFrom(sql<{ value: unknown }>`jsonb_array_elements(event.payload->'verdicts')`.as('element'))
                            .select([
                                sql<string>`element.value->>'rule'`.as('rule'),
                                sql<string>`element.value->>'statement'`.as('statement'),
                                sql<string>`element.value->>'verdict'`.as('verdict'),
                                sql<boolean>`coalesce((element.value->>'reused')::boolean, false)`.as('reused'),
                            ])
                            .as('verdict'),
                    join => join.onTrue(),
                )
                .where('event.project', '=', project)
                .where('event.type', '=', 'rule.verdicts')
                .where('event.createdAt', '>=', since)
                .where('event.createdAt', '<', until)
                .where('verdict.reused', '=', false)
                .select([
                    'verdict.rule',
                    sql<string>`max(verdict.statement)`.as('statement'),
                    sql<string>`count(*) filter (where verdict.verdict = 'fail')`.as('failed'),
                    sql<string>`count(*) filter (where verdict.verdict = 'unavailable')`.as('unavailable'),
                ])
                .groupBy('verdict.rule')
                .execute(),
        ]);

        return {
            since,
            until,
            zone: since.zoneName ?? 'UTC',
            ...foldGateStats(rows),
            rules: rules
                .map(({ rule, statement, failed, unavailable }) => ({ rule, statement, failed: Number(failed), unavailable: Number(unavailable) }))
                .filter(rule => rule.failed > 0 || rule.unavailable > 0)
                .sort((a, b) => b.failed - a.failed || b.unavailable - a.unavailable || a.rule.localeCompare(b.rule)),
        };
    }

    /** What planning and review turns spent from `since` up to `until`. Only an answer with a recorded cost counts as a turn. */
    private async conversationStats(project: string, since: DateTime, until: DateTime): Promise<ProjectConversationStats[]> {
        const figures = (card: string) =>
            [
                sql<string>`count(*)`.as('turns'),
                sql<string>`count(distinct ${sql.ref(card)})`.as('cards'),
                sql<string>`coalesce(sum(coalesce(turn.input_tokens, 0) + coalesce(turn.cached_input_tokens, 0)), 0)`.as('inputTokens'),
                sql<string>`coalesce(sum(turn.cached_input_tokens), 0)`.as('cachedInputTokens'),
                sql<string>`coalesce(sum(turn.output_tokens), 0)`.as('outputTokens'),
            ] as const;

        const [planning, review] = await Promise.all([
            this.db
                .selectFrom('wilson.planTurns as turn')
                .where('turn.project', '=', project)
                .where('turn.role', '=', 'assistant')
                .where('turn.outputTokens', 'is not', null)
                .where('turn.createdAt', '>=', since)
                .where('turn.createdAt', '<', until)
                .select(figures('turn.card_id'))
                .executeTakeFirstOrThrow(),
            this.db
                .selectFrom('wilson.reviewTurns as turn')
                .innerJoin('wilson.reviews as review', 'review.id', 'turn.reviewId')
                .where('review.project', '=', project)
                .where('turn.role', '=', 'assistant')
                .where('turn.outputTokens', 'is not', null)
                .where('turn.createdAt', '>=', since)
                .where('turn.createdAt', '<', until)
                .select(figures('review.card_id'))
                .executeTakeFirstOrThrow(),
        ]);

        return (
            [
                ['planning', planning],
                ['review', review],
            ] as const
        ).map(([kind, row]) => ({
            kind,
            turns: Number(row.turns),
            cards: Number(row.cards),
            inputTokens: Number(row.inputTokens),
            cachedInputTokens: Number(row.cachedInputTokens),
            outputTokens: Number(row.outputTokens),
        }));
    }

    /**
     * What a project has spent in output tokens since a given instant — card 0264's rollup, beside
     * `usageByStage`'s per-card one, that a daily ceiling is checked against. `stage.passed`/
     * `stage.failed` rows, and what rule judges spent, summed across every card in the project rather than grouped by one card's
     * stages, and only `outputTokens`: the ceiling this backs is output-only for the reason
     * `DAILY_OUTPUT_TOKEN_CEILING`'s own doc comment gives, and there is no per-stage grouping to
     * preserve here the way `usageByStage` needs one. An event with no `usage` still coalesces to zero
     * rather than being skipped, the same as `usageByStage`. Unlike `usageByStage`, this leaves out
     * `stage.interrupted` rows, so what an interrupted run spent does not count against the ceiling. A
     * `stage.blocked` run counts: it finished, and the stage is not sent again to spend it twice.
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
            .where('type', 'in', ['stage.passed', 'stage.failed', 'stage.blocked', 'rule.verdicts', 'rule.proposed'])
            .where('createdAt', '>=', since)
            .select(sql<string>`coalesce(sum((payload->'usage'->>'outputTokens')::bigint), 0)`.as('total'))
            .executeTakeFirstOrThrow();

        return Number(row.total);
    }
}
