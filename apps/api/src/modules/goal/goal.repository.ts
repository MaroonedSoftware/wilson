import { Injectable } from 'injectkit';
import { Kysely, sql, type Selectable } from 'kysely';
import { DateTime } from 'luxon';
import type { DB, WilsonGoals } from '#modules/data/db.js';
import type { CardEventType } from '#modules/events/card.event.js';

export type GoalStatus = 'active' | 'paused' | 'done' | 'abandoned';

export interface Goal {
    id: string;
    threadId: string;
    project: string;
    title: string;
    /** What done looks like, in the person's terms. */
    outcome: string;
    status: GoalStatus;
    /** The last `wilson.card_events` row its wake-ups have dealt with. Starts at the newest row when the goal is created. */
    lastEventId: string;
    /** No wake-up runs before this, after one failed. */
    wakeHeldUntil?: DateTime;
    createdAt: DateTime;
    updatedAt: DateTime;
}

export interface NewGoal {
    threadId: string;
    project: string;
    title: string;
    outcome: string;
}

export type GoalChanges = Partial<Pick<Goal, 'title' | 'outcome' | 'status'>>;

export interface GoalFilter {
    project?: string;
    status?: GoalStatus;
    threadId?: string;
}

/** A card as a goal shows it. */
export interface GoalCard {
    id: string;
    title: string;
    stage: string;
    needsHuman: boolean;
}

/** An event on one of a goal's cards, as a wake-up reads it. */
export interface GoalEvent {
    id: string;
    cardId: string;
    stage?: string;
    type: CardEventType;
    payload: unknown;
}

/** What became of linking a card: `missing` for no such card in the goal's project, `taken` when it is in another goal. */
export type LinkOutcome = 'linked' | 'missing' | 'taken';

const toGoal = (row: Selectable<WilsonGoals>): Goal => ({
    id: String(row.id),
    threadId: String(row.threadId),
    project: row.project,
    title: row.title,
    outcome: row.outcome,
    status: row.status as GoalStatus,
    lastEventId: String(row.lastEventId),
    wakeHeldUntil: row.wakeHeldUntil ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

/**
 * `wilson.goals` and `wilson.goal_cards`. Takes a project from the goal rather than from `BoardConfig`,
 * since a goal's page and the chat both work across projects, as a thread does.
 */
@Injectable()
export class GoalRepository {
    constructor(private readonly db: Kysely<DB>) {}

    async create({ threadId, project, title, outcome }: NewGoal): Promise<Goal> {
        const row = await this.db
            .insertInto('wilson.goals')
            .values({
                threadId: BigInt(threadId),
                project,
                title,
                outcome,
                // A goal hears what happens from here on, not what its cards did before it existed.
                lastEventId: sql<bigint>`(select coalesce(max(id), 0) from wilson.card_events)`,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        return toGoal(row);
    }

    async get(id: string): Promise<Goal | undefined> {
        const row = await this.db.selectFrom('wilson.goals').selectAll().where('id', '=', BigInt(id)).executeTakeFirst();
        return row && toGoal(row);
    }

    /** The goals `filter` names, most recently changed first. */
    async list({ project, status, threadId }: GoalFilter = {}): Promise<Goal[]> {
        let query = this.db.selectFrom('wilson.goals').selectAll();
        if (project !== undefined) query = query.where('project', '=', project);
        if (status !== undefined) query = query.where('status', '=', status);
        if (threadId !== undefined) query = query.where('threadId', '=', BigInt(threadId));
        const rows = await query.orderBy('updatedAt', 'desc').orderBy('id', 'desc').execute();
        return rows.map(toGoal);
    }

    /** Undefined when there is no such goal. */
    async update(id: string, changes: GoalChanges): Promise<Goal | undefined> {
        if (Object.keys(changes).length === 0) return this.get(id);
        const row = await this.db.updateTable('wilson.goals').set(changes).where('id', '=', BigInt(id)).returningAll().executeTakeFirst();
        return row && toGoal(row);
    }

    /** Put a card in `goal`. Linking a card the goal already holds is fine, and changes nothing. */
    async linkCard(goal: Pick<Goal, 'id' | 'project'>, cardId: string): Promise<LinkOutcome> {
        const card = await this.db
            .selectFrom('wilson.cards')
            .select('id')
            .where('project', '=', goal.project)
            .where('id', '=', cardId)
            .executeTakeFirst();
        if (!card) return 'missing';

        await this.db
            .insertInto('wilson.goalCards')
            .values({ project: goal.project, cardId, goalId: BigInt(goal.id) })
            .onConflict(conflict => conflict.columns(['project', 'cardId']).doNothing())
            .execute();
        const held = await this.db
            .selectFrom('wilson.goalCards')
            .select('goalId')
            .where('project', '=', goal.project)
            .where('cardId', '=', cardId)
            .executeTakeFirstOrThrow();
        return String(held.goalId) === goal.id ? 'linked' : 'taken';
    }

    /** Take a card out of `goalId`. True when it was in that goal. */
    async unlinkCard(goalId: string, cardId: string): Promise<boolean> {
        const result = await this.db
            .deleteFrom('wilson.goalCards')
            .where('goalId', '=', BigInt(goalId))
            .where('cardId', '=', cardId)
            .executeTakeFirst();
        return result.numDeletedRows > 0n;
    }

    /** A goal's cards, lowest id first. */
    async cards(goalId: string): Promise<GoalCard[]> {
        return this.db
            .selectFrom('wilson.goalCards as link')
            .innerJoin('wilson.cards as card', join => join.onRef('card.project', '=', 'link.project').onRef('card.id', '=', 'link.cardId'))
            .select(['card.id', 'card.title', 'card.stage', 'card.needsHuman'])
            .where('link.goalId', '=', BigInt(goalId))
            .orderBy('card.id')
            .execute();
    }

    /** The goals a wake-up could run for now: active, on a thread still open, and not held back. */
    async wakeable(): Promise<Goal[]> {
        const rows = await this.db
            .selectFrom('wilson.goals as goal')
            .innerJoin('wilson.chatThreads as thread', 'thread.id', 'goal.threadId')
            .selectAll('goal')
            .where('goal.status', '=', 'active')
            .where('thread.archivedAt', 'is', null)
            .where(eb => eb.or([eb('goal.wakeHeldUntil', 'is', null), eb('goal.wakeHeldUntil', '<=', DateTime.now())]))
            .orderBy('goal.id')
            .execute();
        return rows.map(toGoal);
    }

    /** Events of `types` on the goal's cards past its cursor, oldest first. */
    async eventsAfter(goal: Pick<Goal, 'id' | 'lastEventId'>, types: CardEventType[], limit: number): Promise<GoalEvent[]> {
        const rows = await this.db
            .selectFrom('wilson.cardEvents as event')
            .innerJoin('wilson.goalCards as link', join => join.onRef('link.project', '=', 'event.project').onRef('link.cardId', '=', 'event.cardId'))
            .select(['event.id', 'event.cardId', 'event.stage', 'event.type', 'event.payload'])
            .where('link.goalId', '=', BigInt(goal.id))
            .where('event.id', '>', BigInt(goal.lastEventId))
            .where('event.type', 'in', types)
            .orderBy('event.id')
            .limit(limit)
            .execute();
        return rows.map(row => ({
            id: String(row.id),
            cardId: row.cardId,
            stage: row.stage ?? undefined,
            type: row.type as CardEventType,
            payload: row.payload,
        }));
    }

    /** Move a goal's cursor forward, which a turn that got this far has earned, and lift any hold. */
    async advanceCursor(id: string, eventId: string): Promise<void> {
        await this.db
            .updateTable('wilson.goals')
            .set({ lastEventId: BigInt(eventId), wakeHeldUntil: null })
            .where('id', '=', BigInt(id))
            .execute();
    }

    async holdWake(id: string, until: DateTime): Promise<void> {
        await this.db.updateTable('wilson.goals').set({ wakeHeldUntil: until }).where('id', '=', BigInt(id)).execute();
    }

    /** What a project's goal threads have spent since `since`, a person's own messages on them included. */
    async outputTokensSince(project: string, since: DateTime): Promise<number> {
        const row = await this.db
            .selectFrom('wilson.chatTurnUsage as usage')
            .innerJoin('wilson.goals as goal', 'goal.threadId', 'usage.threadId')
            .where('goal.project', '=', project)
            .where('usage.createdAt', '>=', since)
            .select(sql<string>`coalesce(sum(usage.output_tokens), 0)`.as('total'))
            .executeTakeFirstOrThrow();
        return Number(row.total);
    }
}
