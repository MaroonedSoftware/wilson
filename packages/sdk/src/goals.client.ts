import type { CreateGoalRequest, Goal, GoalDetail, ListGoalsQuery, UpdateGoalRequest } from './types/goals.js';
import { reviveGoal, reviveGoalDetail } from './types/goals.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [goals.ck](../../../apps/api/data/contracts/goals.ck)
 */
export class GoalsClient {
    constructor(private fetch: SdkFetch) {}

    /**
     * @name List goals
     * @description The goals a project or thread has, most recently changed first. Filter by project, status or threadId.
     */
    async listGoals(query?: ListGoalsQuery): Promise<Goal[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/goals${qs}`, {
            method: 'GET',
        });
        return (await parseJson<Goal[]>(result)).map(reviveGoal);
    }

    /**
     * @name Create a goal
     * @description Start a goal on a chat thread with no goal yet, for one registered project. `outcome` says what done looks like.
     */
    async createAGoal(body: CreateGoalRequest): Promise<Goal> {
        const result = await this.fetch(`/api/goals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveGoal(await parseJson<Goal>(result));
    }

    /**
     * @name Get a goal
     * @description A goal with its cards, each card's stage, and whether it is flagged for a person.
     */
    async getAGoal(id: string): Promise<GoalDetail> {
        const result = await this.fetch(`/api/goals/${encodeURIComponent(id)}`, { method: 'GET' });
        return reviveGoalDetail(await parseJson<GoalDetail>(result));
    }

    /**
     * @name Update a goal
     * @description Change a goal's title, outcome or status. Anything left out stays as it is.
     */
    async updateAGoal(id: string, body: UpdateGoalRequest): Promise<Goal> {
        const result = await this.fetch(`/api/goals/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveGoal(await parseJson<Goal>(result));
    }

    /**
     * @name Add a card to a goal
     * @description Linking a card the goal already holds changes nothing. A card is in at most one goal, so one that
     * another goal holds is refused rather than moved.
     * Put a card from the goal's own project in the goal. Refused when another goal holds it.
     */
    async addACardToAGoal(id: string, cardId: string): Promise<GoalDetail> {
        const result = await this.fetch(`/api/goals/${encodeURIComponent(id)}/cards/${encodeURIComponent(cardId)}`, { method: 'PUT' });
        return reviveGoalDetail(await parseJson<GoalDetail>(result));
    }

    /**
     * @name Remove a card from a goal
     * @description Take a card out of the goal. The card itself is untouched.
     */
    async removeACardFromAGoal(id: string, cardId: string): Promise<GoalDetail> {
        const result = await this.fetch(`/api/goals/${encodeURIComponent(id)}/cards/${encodeURIComponent(cardId)}`, { method: 'DELETE' });
        return reviveGoalDetail(await parseJson<GoalDetail>(result));
    }
}
