import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);
type _JsonValue = string | number | boolean | null | _JsonValue[] | { [key: string]: _JsonValue };
const _ZodJson: z.ZodType<_JsonValue> = z.lazy(() =>
    z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(_ZodJson), z.record(z.string(), _ZodJson)]),
);

/**
 * generated from [ChatThread](../../data/contracts/chat.ck)
 */
export const ChatThread = z.strictObject({
    id: z.string(),
    title: z.string().describe("Named after the thread's first message; the person may rename it."),
    engine: z.enum(['api', 'cli']).describe("'api' is the AI SDK, 'cli' the Claude Agent SDK. Fixed when the thread is made."),
    createdAt: _ZodDatetime,
    updatedAt: _ZodDatetime,
    archivedAt: _ZodDatetime.optional(),
});
export type ChatThread = z.infer<typeof ChatThread>;

/**
 * One catalog operation the agent ran while answering: what the chat shows of its working.
 * generated from [ChatOperation](../../data/contracts/chat.ck)
 */
export const ChatOperation = z.strictObject({
    name: z.string(),
    arguments: _ZodJson,
    project: z.string().optional(),
    ok: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type ChatOperation = z.infer<typeof ChatOperation>;

/**
 * A change the agent proposed. `pending` until the person decides it; `running` while its operation
 * runs; then `done` with its `result` or `failed` with its `error`. `declined` when the person said no.
 * A pending action past `expiresAt` can no longer be confirmed.
 * generated from [ChatPendingAction](../../data/contracts/chat.ck)
 */
export const ChatPendingAction = z.strictObject({
    id: z.string(),
    threadId: z.string(),
    project: z.string().optional(),
    operation: z.string(),
    arguments: _ZodJson,
    summary: z.string(),
    status: z.enum(['pending', 'running', 'done', 'failed', 'declined']),
    result: _ZodJson.optional(),
    error: z.string().optional(),
    expiresAt: _ZodDatetime,
    decidedAt: _ZodDatetime.optional(),
    createdAt: _ZodDatetime,
});
export type ChatPendingAction = z.infer<typeof ChatPendingAction>;

/**
 * generated from [RenameChatThreadRequest](../../data/contracts/chat.ck)
 */
export const RenameChatThreadRequest = z.strictObject({
    title: z.string(),
});
export type RenameChatThreadRequest = z.infer<typeof RenameChatThreadRequest>;

/**
 * generated from [SendChatMessageRequest](../../data/contracts/chat.ck)
 */
export const SendChatMessageRequest = z.strictObject({
    text: z.string(),
    project: z.string().optional().describe('The project of the page the person is on, if any: the agent assumes it unless told otherwise.'),
});
export type SendChatMessageRequest = z.infer<typeof SendChatMessageRequest>;

/**
 * generated from [DecideChatActionRequest](../../data/contracts/chat.ck)
 */
export const DecideChatActionRequest = z.strictObject({
    decision: z.enum(['confirm', 'decline']),
});
export type DecideChatActionRequest = z.infer<typeof DecideChatActionRequest>;

/**
 * generated from [ChatMessage](../../data/contracts/chat.ck)
 */
export const ChatMessage = z.strictObject({
    seq: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    role: z.enum(['user', 'assistant']),
    content: z.string().describe('Markdown, for an answer.'),
    operations: z.array(ChatOperation),
    createdAt: _ZodDatetime,
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/**
 * generated from [ChatThreadDetail](../../data/contracts/chat.ck)
 */
export const ChatThreadDetail = z.strictObject({
    thread: ChatThread,
    messages: z.array(ChatMessage),
    actions: z.array(ChatPendingAction),
});
export type ChatThreadDetail = z.infer<typeof ChatThreadDetail>;

/**
 * What one turn produced: the person's message as stored, the agent's answer, and any changes the
 * answer proposed. The answer streams over `GET /api/chat/threads/{id}/stream` while this request is
 * still open; this response is the stored record of it.
 * generated from [ChatTurnResult](../../data/contracts/chat.ck)
 */
export const ChatTurnResult = z.strictObject({
    message: ChatMessage,
    reply: ChatMessage,
    proposed: z.array(ChatPendingAction),
});
export type ChatTurnResult = z.infer<typeof ChatTurnResult>;
