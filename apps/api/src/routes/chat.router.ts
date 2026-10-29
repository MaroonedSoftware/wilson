import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { ChatService } from '#modules/chat/chat.service.js';
import {
    ChatPendingAction,
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
 * anonymous access, no security required
 */
ChatRouter.get('/api/chat/threads', async ctx => {
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
 * anonymous access, no security required
 */
ChatRouter.post('/api/chat/threads', async ctx => {
    const service = ctx.container.get(ChatService);
    const result: ChatThread = await service.startThread();

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [chat.ck](../../data/contracts/chat.ck) `GET /api/chat/threads/{id}`
 * anonymous access, no security required
 */
ChatRouter.get('/api/chat/threads/:id', async ctx => {
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
 * anonymous access, no security required
 */
ChatRouter.patch('/api/chat/threads/:id', bodyParserMiddleware(['json']), async ctx => {
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
 * anonymous access, no security required
 */
ChatRouter.post('/api/chat/threads/:id/archive', async ctx => {
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
 * anonymous access, no security required
 */
ChatRouter.post('/api/chat/threads/:id/messages', bodyParserMiddleware(['json']), async ctx => {
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
 * anonymous access, no security required
 */
ChatRouter.post('/api/chat/actions/:id/decision', bodyParserMiddleware(['json']), async ctx => {
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
