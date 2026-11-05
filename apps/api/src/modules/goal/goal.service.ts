import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { ChatThreadRepository } from '#modules/chat/chat.thread.repository.js';
import type { CreateGoalRequest, Goal as WireGoal, GoalDetail, ListGoalsQuery, UpdateGoalRequest } from '#src/generated/goals.js';
import { GoalRepository, type Goal, type GoalChanges } from './goal.repository.js';

/** An id `BigInt` can read. A client's or an agent's guess reaches here unchecked, and an unknown goal is a 404, not a 500. */
const isId = (id: string): boolean => /^\d+$/.test(id);

const required = (value: string, what: string): string => {
    const trimmed = value.trim();
    if (!trimmed) throw httpError(400).withDetails({ reason: `a goal needs ${what}` });
    return trimmed;
};

const toWire = (goal: Goal): WireGoal => ({
    id: goal.id,
    threadId: goal.threadId,
    project: goal.project,
    title: goal.title,
    outcome: goal.outcome,
    status: goal.status,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
});

/** Goals (`goals.ck`): one thread, one project, and the cards that deliver it. */
@Injectable()
export class GoalService {
    constructor(
        private readonly goals: GoalRepository,
        private readonly threads: ChatThreadRepository,
        private readonly projects: ProjectRepository,
    ) {}

    async list({ project, status, threadId }: ListGoalsQuery): Promise<WireGoal[]> {
        if (threadId !== undefined && !isId(threadId)) return [];
        return (await this.goals.list({ project, status, threadId })).map(toWire);
    }

    async create({ threadId, project, title, outcome }: CreateGoalRequest): Promise<WireGoal> {
        const named = required(title, 'a title');
        const done = required(outcome, 'an outcome');

        const thread = isId(threadId) ? await this.threads.get(threadId) : undefined;
        if (!thread) throw httpError(404).withDetails({ reason: `chat thread ${threadId} not found` });
        if (thread.archivedAt) throw httpError(400).withDetails({ reason: `chat thread ${threadId} is archived` });
        if (!(await this.projects.find(project))) throw httpError(400).withDetails({ reason: `project "${project}" is not registered` });

        const [existing] = await this.goals.list({ threadId });
        if (existing) throw httpError(409).withDetails({ reason: `chat thread ${threadId} already has goal ${existing.id}` });

        return toWire(await this.goals.create({ threadId, project, title: named, outcome: done }));
    }

    async get(id: string): Promise<GoalDetail> {
        return this.detail(await this.goalOrThrow(id));
    }

    async update(id: string, { title, outcome, status }: UpdateGoalRequest): Promise<WireGoal> {
        await this.goalOrThrow(id);
        const changes: GoalChanges = {
            ...(title !== undefined ? { title: required(title, 'a title') } : {}),
            ...(outcome !== undefined ? { outcome: required(outcome, 'an outcome') } : {}),
            ...(status !== undefined ? { status } : {}),
        };
        const goal = await this.goals.update(id, changes);
        if (!goal) throw this.notFound(id);
        return toWire(goal);
    }

    async addCard(id: string, cardId: string): Promise<GoalDetail> {
        const goal = await this.goalOrThrow(id);
        const outcome = await this.goals.linkCard(goal, cardId);
        if (outcome === 'missing') throw httpError(404).withDetails({ reason: `card ${cardId} not found in project "${goal.project}"` });
        if (outcome === 'taken') throw httpError(409).withDetails({ reason: `card ${cardId} is already in another goal` });
        return this.detail(goal);
    }

    async removeCard(id: string, cardId: string): Promise<GoalDetail> {
        const goal = await this.goalOrThrow(id);
        if (!(await this.goals.unlinkCard(id, cardId))) throw httpError(404).withDetails({ reason: `card ${cardId} is not in goal ${id}` });
        return this.detail(goal);
    }

    private async detail(goal: Goal): Promise<GoalDetail> {
        return { goal: toWire(goal), cards: await this.goals.cards(goal.id) };
    }

    private async goalOrThrow(id: string): Promise<Goal> {
        const goal = isId(id) ? await this.goals.get(id) : undefined;
        if (!goal) throw this.notFound(id);
        return goal;
    }

    private notFound(id: string) {
        return httpError(404).withDetails({ reason: `goal ${id} not found` });
    }
}
