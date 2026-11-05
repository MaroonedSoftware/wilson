import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { GoalService } from '#modules/goal/goal.service.js';
import { CreateGoalRequest, Goal, GoalDetail, ListGoalsQuery, UpdateGoalRequest } from '../generated/goals.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [goals.ck](../../data/contracts/goals.ck)
 */
export const GoalsRouter = ServerKitRouter();

/**
 * The goals a project or thread has, most recently changed first. Filter by project, status or threadId.
 * from [goals.ck](../../data/contracts/goals.ck) `GET /api/goals`
 */
GoalsRouter.get('/api/goals', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const query = await parseAndValidate(ctx.query, ListGoalsQuery.strict());

    const service = ctx.container.get(GoalService);
    const result: Goal[] = await service.list(query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Start a goal on a chat thread with no goal yet, for one registered project. `outcome` says what done looks like.
 * from [goals.ck](../../data/contracts/goals.ck) `POST /api/goals`
 */
GoalsRouter.post('/api/goals', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, CreateGoalRequest);

    const service = ctx.container.get(GoalService);
    const result: Goal = await service.create(body);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * A goal with its cards, each card's stage, and whether it is flagged for a person.
 * from [goals.ck](../../data/contracts/goals.ck) `GET /api/goals/{id}`
 */
GoalsRouter.get('/api/goals/:id', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(GoalService);
    const result: GoalDetail = await service.get(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Change a goal's title, outcome or status. Anything left out stays as it is.
 * from [goals.ck](../../data/contracts/goals.ck) `PATCH /api/goals/{id}`
 */
GoalsRouter.patch('/api/goals/:id', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, UpdateGoalRequest);

    const service = ctx.container.get(GoalService);
    const result: Goal = await service.update(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Linking a card the goal already holds changes nothing. A card is in at most one goal, so one that
 * another goal holds is refused rather than moved.
 * Put a card from the goal's own project in the goal. Refused when another goal holds it.
 * from [goals.ck](../../data/contracts/goals.ck) `PUT /api/goals/{id}/cards/{cardId}`
 */
GoalsRouter.put('/api/goals/:id/cards/:cardId', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { id, cardId } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
            cardId: z.string(),
        }),
    );

    const service = ctx.container.get(GoalService);
    const result: GoalDetail = await service.addCard(id, cardId);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Take a card out of the goal. The card itself is untouched.
 * from [goals.ck](../../data/contracts/goals.ck) `DELETE /api/goals/{id}/cards/{cardId}`
 */
GoalsRouter.delete('/api/goals/:id/cards/:cardId', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { id, cardId } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
            cardId: z.string(),
        }),
    );

    const service = ctx.container.get(GoalService);
    const result: GoalDetail = await service.removeCard(id, cardId);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
