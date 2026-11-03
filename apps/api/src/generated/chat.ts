import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodBinary = z.custom<Buffer>(val => Buffer.isBuffer(val), { error: 'Must be binary data' });
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
 * An image sent in a chat. Metadata only, like `CardAttachment` and for its reason: the bytes come from
 * `GET .../attachments/{attachmentId}`. `contentType` is the type sniffed from the bytes, never the one
 * the uploader declared.
 * generated from [ChatAttachment](../../data/contracts/chat.ck)
 */
export const ChatAttachment = z.strictObject({
    id: z.string(),
    filename: z.string(),
    contentType: z.string(),
    byteSize: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    contentHash: z.string(),
    createdAt: _ZodDatetime,
});
export type ChatAttachment = z.infer<typeof ChatAttachment>;

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
 * One suggested answer to a `ChatQuestion`.
 * generated from [ChatQuestionOption](../../data/contracts/chat.ck)
 */
export const ChatQuestionOption = z.strictObject({
    label: z.string(),
    description: z.string(),
});
export type ChatQuestionOption = z.infer<typeof ChatQuestionOption>;

/**
 * One question's answer: the options chosen, by index into its own `options` (never by label — a
 * submission is validated against the stored question, not a string match), and any "Other" text.
 * generated from [ChatQuestionAnswer](../../data/contracts/chat.ck)
 */
export const ChatQuestionAnswer = z.strictObject({
    chosen: z.array(z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())),
    other: z.string().optional(),
});
export type ChatQuestionAnswer = z.infer<typeof ChatQuestionAnswer>;

/**
 * generated from [RenameChatThreadRequest](../../data/contracts/chat.ck)
 */
export const RenameChatThreadRequest = z.strictObject({
    title: z.string(),
});
export type RenameChatThreadRequest = z.infer<typeof RenameChatThreadRequest>;

/**
 * Documentation, not validation, as `AttachImageUpload` is.
 * generated from [AttachChatImageUpload](../../data/contracts/chat.ck)
 */
export const AttachChatImageUpload = z.strictObject({
    file: _ZodBinary,
});
export type AttachChatImageUpload = z.infer<typeof AttachChatImageUpload>;

/**
 * generated from [SendChatMessageRequest](../../data/contracts/chat.ck)
 */
export const SendChatMessageRequest = z.strictObject({
    text: z.string().describe('May be empty when `attachments` is not.'),
    project: z.string().optional().describe('The project of the page the person is on, if any: the agent assumes it unless told otherwise.'),
    attachments: z
        .array(z.string())
        .optional()
        .describe(
            'Ids from `POST .../attachments`, each usable once, at most five. A send that fails after the\nmessage was stored has used them, so a retry uploads again.',
        ),
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
    suggestions: z.array(z.string()).optional().describe('What the answer offers to ask next, left out when it offers nothing.'),
    attachments: z.array(ChatAttachment).optional().describe('The images a person sent with this message, left out when there are none.'),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/**
 * One of the 1-4 prompts an `ask_user` call asks together, as the agent asked it.
 * generated from [ChatQuestion](../../data/contracts/chat.ck)
 */
export const ChatQuestion = z.strictObject({
    header: z.string(),
    text: z.string(),
    options: z.array(ChatQuestionOption),
    multiSelect: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type ChatQuestion = z.infer<typeof ChatQuestion>;

/**
 * `POST .../questions/{questionId}/answers`'s request: one answer per question asked, in order.
 * generated from [AnswerChatQuestionsRequest](../../data/contracts/chat.ck)
 */
export const AnswerChatQuestionsRequest = z.strictObject({
    answers: z.array(ChatQuestionAnswer),
});
export type AnswerChatQuestionsRequest = z.infer<typeof AnswerChatQuestionsRequest>;

/**
 * A question the agent asked, waiting on the person. `pending` until they answer it or an ordinary
 * message on the thread dismisses it (`ChatService.sendMessage`); `answered` once they submit. A
 * pending question past `expiresAt` can no longer be answered.
 * generated from [ChatPendingQuestion](../../data/contracts/chat.ck)
 */
export const ChatPendingQuestion = z.strictObject({
    id: z.string(),
    threadId: z.string(),
    questions: z.array(ChatQuestion),
    answers: z.array(ChatQuestionAnswer).optional(),
    status: z.enum(['pending', 'answered', 'dismissed']),
    expiresAt: _ZodDatetime,
    decidedAt: _ZodDatetime.optional(),
    createdAt: _ZodDatetime,
});
export type ChatPendingQuestion = z.infer<typeof ChatPendingQuestion>;

/**
 * generated from [ChatThreadDetail](../../data/contracts/chat.ck)
 */
export const ChatThreadDetail = z.strictObject({
    thread: ChatThread,
    messages: z.array(ChatMessage),
    actions: z.array(ChatPendingAction),
    questions: z.array(ChatPendingQuestion),
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
    asked: z.array(ChatPendingQuestion),
});
export type ChatTurnResult = z.infer<typeof ChatTurnResult>;
