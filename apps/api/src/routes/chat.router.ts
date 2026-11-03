import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { ChatAttachmentService } from '#modules/chat/chat.attachment.service.js';
import { ChatService } from '#modules/chat/chat.service.js';
import {
    AnswerChatQuestionsRequest,
    ChatAttachment,
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
import { MultipartBody } from '@maroonedsoftware/multipart';

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
 * provider, say) answers 503 with the reason, and the person's message is kept. Not 502: Cloudflare
 * replaces an origin's 502 with its own page, and the reason goes with it.
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
 * An image goes up before the message that carries it, so a message's send stays JSON. One that no
 * message claims is removed a day later.
 * from [chat.ck](../../data/contracts/chat.ck) `POST /api/chat/threads/{id}/attachments`
 */
ChatRouter.post('/api/chat/threads/:id/attachments', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['multipart']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const multipartBody = ctx.parsedBody as MultipartBody;

    const service = ctx.container.get(ChatAttachmentService);
    const result: ChatAttachment = await service.upload(id, multipartBody);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * `attachmentId`, not a second `id`: a `params` block is keyed by name. One 404 covers a thread that
 * does not exist and an attachment id that does not exist, belongs to another thread, or is not an id.
 * from [chat.ck](../../data/contracts/chat.ck) `GET /api/chat/threads/{id}/attachments/{attachmentId}`
 */
ChatRouter.get('/api/chat/threads/:id/attachments/:attachmentId', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { id, attachmentId } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
            attachmentId: z.string(),
        }),
    );

    const service = ctx.container.get(ChatAttachmentService);
    const result: {
        contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
        body: Buffer;
        headers: { xContentTypeOptions: string; contentSecurityPolicy: string };
    } = await service.bytes(id, attachmentId);

    ctx.status = 200;
    ctx.set('x-content-type-options', String(result.headers['xContentTypeOptions']));
    ctx.set('content-security-policy', String(result.headers['contentSecurityPolicy']));
    ctx.type = result.contentType;
    ctx.body = result.body;
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
