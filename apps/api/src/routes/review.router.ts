import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { ReviewService } from '#modules/review/review.service.js';
import { CreateReviewCommentRequest, ReviewComment, ReviewState, ReviewTurn, ReviewTurnRequest, ReviewVerdictRequest } from '../generated/review.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [review.ck](../../data/contracts/review.ck)
 */
export const ReviewRouter = ServerKitRouter();

/**
 * from [review.ck](../../data/contracts/review.ck) `GET /api/cards/{id}/review`
 */
ReviewRouter.get('/api/cards/:id/review', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(ReviewService);
    const result: ReviewState = await service.state(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Rejoins the review of the branch's current commit, or starts one, retiring any older open one.
 * from [review.ck](../../data/contracts/review.ck) `POST /api/cards/{id}/review`
 */
ReviewRouter.post('/api/cards/:id/review', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(ReviewService);
    const result: ReviewState = await service.open(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [review.ck](../../data/contracts/review.ck) `POST /api/cards/{id}/review/comments`
 */
ReviewRouter.post('/api/cards/:id/review/comments', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, CreateReviewCommentRequest);

    const service = ctx.container.get(ReviewService);
    const result: ReviewComment = await service.addComment(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * A state the comment moves through rather than a delete. A comment already sent stays sent.
 * from [review.ck](../../data/contracts/review.ck) `POST /api/cards/{id}/review/comments/{commentId}/resolve`
 */
ReviewRouter.post('/api/cards/:id/review/comments/:commentId/resolve', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { id, commentId } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
            commentId: z.string(),
        }),
    );

    const service = ctx.container.get(ReviewService);
    const result: ReviewComment = await service.resolveComment(id, commentId);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Sends every open comment to `ready`'s `onFail` stage as findings, and moves the card there. Comments are
 * marked `sent`, so a later review re-locates them but does not send them again.
 * from [review.ck](../../data/contracts/review.ck) `POST /api/cards/{id}/review/request-changes`
 */
ReviewRouter.post('/api/cards/:id/review/request-changes', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, ReviewVerdictRequest);

    const service = ctx.container.get(ReviewService);
    const result: ReviewState = await service.requestChanges(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Records the person's approval of the branch at `head`. The card stays where it is and merging is not
 * gated on this. An open blocker refuses it; an open concern does not.
 * from [review.ck](../../data/contracts/review.ck) `POST /api/cards/{id}/review/approve`
 */
ReviewRouter.post('/api/cards/:id/review/approve', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, ReviewVerdictRequest);

    const service = ctx.container.get(ReviewService);
    const result: ReviewState = await service.approve(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * The conversation with the agent walking the person through the change. It reads committed code at the
 * review's commit and has no way to change anything. A turn's answer arrives as it is written over
 * `GET .../review/stream`, a hand-built route in `routes.setup.ts` because this file can't describe a
 * response that never resolves. It sends `delta`, then `done` or `failed`.
 * from [review.ck](../../data/contracts/review.ck) `GET /api/cards/{id}/review/turns`
 */
ReviewRouter.get('/api/cards/:id/review/turns', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(ReviewService);
    const result: ReviewTurn[] = await service.turns(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * The conversation with the agent walking the person through the change. It reads committed code at the
 * review's commit and has no way to change anything. A turn's answer arrives as it is written over
 * `GET .../review/stream`, a hand-built route in `routes.setup.ts` because this file can't describe a
 * response that never resolves. It sends `delta`, then `done` or `failed`.
 * from [review.ck](../../data/contracts/review.ck) `POST /api/cards/{id}/review/turns`
 */
ReviewRouter.post('/api/cards/:id/review/turns', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, ReviewTurnRequest);

    const service = ctx.container.get(ReviewService);
    const result: ReviewTurn = await service.sendTurn(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
