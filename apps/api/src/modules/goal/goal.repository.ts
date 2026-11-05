import { Injectable } from 'injectkit';
import { Kysely, type Selectable } from 'kysely';
import type { DateTime } from 'luxon';
import type { DB, WilsonGoals } from '#modules/data/db.js';

export type GoalStatus = 'active' | 'paused' | 'done' | 'abandoned';

export interface Goal {
    id: string;
    threadId: string;
    project: string;
    title: string;
    /** What done looks like, in the person's terms. */
    outcome: string;
    status: GoalStatus;
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

/** What became of linking a card: `missing` for no such card in the goal's project, `taken` when it is in another goal. */
export type LinkOutcome = 'linked' | 'missing' | 'taken';

const toGoal = (row: Selectable<WilsonGoals>): Goal => ({
    id: String(row.id),
    threadId: String(row.threadId),
    project: row.project,
    title: row.title,
    outcome: row.outcome,
    status: row.status as GoalStatus,
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
            .values({ threadId: BigInt(threadId), project, title, outcome })
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
}
