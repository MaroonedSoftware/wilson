import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { ChatService } from '#modules/chat/chat.service.js';
import {
    AnswerChatQuestionsRequest,
    ChatPendingAction,
    ChatPendingQuestion,
    ChatThread,
    ChatThreadDetail,
    ChatTurnResult,
    DecideChatActionRequest,
    RenameChatThreadRequest,
    SendChatMessageRequest,
} from '../generated/chat.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [chat.ck](../../data/contracts/chat.ck)
 */
export const ChatRouter = ServerKitRouter();

/**
 * from [chat.ck](../../data/contracts/chat.ck) `GET /api/chat/threads`
 */
ChatRouter.get('/api/chat/threads', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(ChatService);
    const result: ChatThread[] = await service.listThreads();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Starts an empty thread on the engine the `chat-engine` setting names now; its first message
 * names it.
 * from [chat.ck](../../data/contracts/chat.ck) `POST /api/chat/threads`
 */
ChatRouter.post('/api/chat/threads', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const service = ctx.container.get(ChatService);
    const result: ChatThread = await service.startThread();

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [chat.ck](../../data/contracts/chat.ck) `GET /api/chat/threads/{id}`
 */
ChatRouter.get('/api/chat/threads/:id', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(ChatService);
    const result: ChatThreadDetail = await service.getThread(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [chat.ck](../../data/contracts/chat.ck) `PATCH /api/chat/threads/{id}`
 */
ChatRouter.patch('/api/chat/threads/:id', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, RenameChatThreadRequest);

    const service = ctx.container.get(ChatService);
    const result: ChatThread = await service.renameThread(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Archiving takes a thread out of the list; its messages stay.
 * from [chat.ck](../../data/contracts/chat.ck) `POST /api/chat/threads/{id}/archive`
 */
ChatRouter.post('/api/chat/threads/:id/archive', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(ChatService);
    const result: ChatThread = await service.archiveThread(id);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Runs one turn and answers once it is stored. A turn that cannot run (no API key for the engine's
 * provider, say) answers 502 with the reason, and the person's message is kept.
 * from [chat.ck](../../data/contracts/chat.ck) `POST /api/chat/threads/{id}/messages`
 */
ChatRouter.post('/api/chat/threads/:id/messages', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, SendChatMessageRequest);

    const service = ctx.container.get(ChatService);
    const result: ChatTurnResult = await service.sendMessage(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Confirm runs the proposed operation, at most once however many times it is sent, and answers with
 * how it went: a failed operation is a 200 with `status: failed` and its `error`, since the decision
 * itself succeeded. A proposal already decided, or expired, is a 409.
 * from [chat.ck](../../data/contracts/chat.ck) `POST /api/chat/actions/{id}/decision`
 */
ChatRouter.post('/api/chat/actions/:id/decision', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, DecideChatActionRequest);

    const service = ctx.container.get(ChatService);
    const result: ChatPendingAction = await service.decide(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Answers a question `ask_user` asked, choosing options by index and/or typing free text under
 * "Other". A valid submission moves the row to `answered` and starts a follow-up turn on the thread,
 * carrying the chosen labels and any "Other" text as a note from Wilson — the same mechanism a
 * confirmed change already uses (`POST .../decision`) — never a `role: 'user'` message in the
 * person's name. The second path param is `questionId`, not `id`: contractkit keys a `params` block
 * by name, so two `{id}` segments in one path cannot be expressed (see `.../context/{contextId}` in
 * `context.ck` and `.../comments/{commentId}/resolve` in `board.ck` for the same shape). One
 * consequence of nesting under the thread, which is the point of it: the same 404 below covers either
 * id not existing — the thread, or a question id that does not belong to it.
 * from [chat.ck](../../data/contracts/chat.ck) `POST /api/chat/threads/{id}/questions/{questionId}/answers`
 */
ChatRouter.post(
    '/api/chat/threads/:id/questions/:questionId/answers',
    requirePolicy({ policy: 'wilson.manage' }),
    bodyParserMiddleware(['json']),
    async ctx => {
        const { id, questionId } = await parseAndValidate(
            ctx.params,
            z.strictObject({
                id: z.string(),
                questionId: z.string(),
            }),
        );

        const body = await parseAndValidate(ctx.parsedBody, AnswerChatQuestionsRequest);

        const service = ctx.container.get(ChatService);
        const result: ChatPendingQuestion = await service.answerQuestions(id, questionId, body);

        ctx.status = 200;
        ctx.type = 'application/json';
        ctx.body = result;
    },
);
