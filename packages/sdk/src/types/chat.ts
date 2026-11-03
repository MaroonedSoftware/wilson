import { DateTime } from 'luxon';
import type { JsonValue } from '../sdk-options.js';

const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * generated from [ChatThread](../../../../apps/api/data/contracts/chat.ck)
 */
export interface ChatThread {
    id: string;
    /** Named after the thread's first message; the person may rename it. */
    title: string;
    /** 'api' is the AI SDK, 'cli' the Claude Agent SDK. Fixed when the thread is made. */
    engine: 'api' | 'cli';
    createdAt: DateTime;
    updatedAt: DateTime;
    archivedAt?: DateTime;
}

/** Rehydrates every wire-encoded scalar in a ChatThread into its runtime type. Mutates and returns `raw`. */
export function reviveChatThread(raw: ChatThread): ChatThread {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'ChatThread.createdAt');
    __o0['updatedAt'] = __dt(__o0['updatedAt'], 'ChatThread.updatedAt');
    if (__o0['archivedAt'] != null) {
        __o0['archivedAt'] = __dt(__o0['archivedAt'], 'ChatThread.archivedAt');
    }
    return raw;
}

/**
 * One catalog operation the agent ran while answering: what the chat shows of its working.
 * generated from [ChatOperation](../../../../apps/api/data/contracts/chat.ck)
 */
export interface ChatOperation {
    name: string;
    arguments: JsonValue;
    project?: string;
    ok: boolean;
}

/**
 * A change the agent proposed. `pending` until the person decides it; `running` while its operation
 * runs; then `done` with its `result` or `failed` with its `error`. `declined` when the person said no.
 * A pending action past `expiresAt` can no longer be confirmed.
 * generated from [ChatPendingAction](../../../../apps/api/data/contracts/chat.ck)
 */
export interface ChatPendingAction {
    id: string;
    threadId: string;
    project?: string;
    operation: string;
    arguments: JsonValue;
    summary: string;
    status: 'pending' | 'running' | 'done' | 'failed' | 'declined';
    result?: JsonValue;
    error?: string;
    expiresAt: DateTime;
    decidedAt?: DateTime;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a ChatPendingAction into its runtime type. Mutates and returns `raw`. */
export function reviveChatPendingAction(raw: ChatPendingAction): ChatPendingAction {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['expiresAt'] = __dt(__o0['expiresAt'], 'ChatPendingAction.expiresAt');
    if (__o0['decidedAt'] != null) {
        __o0['decidedAt'] = __dt(__o0['decidedAt'], 'ChatPendingAction.decidedAt');
    }
    __o0['createdAt'] = __dt(__o0['createdAt'], 'ChatPendingAction.createdAt');
    return raw;
}

/**
 * One suggested answer to a `ChatQuestion`.
 * generated from [ChatQuestionOption](../../../../apps/api/data/contracts/chat.ck)
 */
export interface ChatQuestionOption {
    label: string;
    description: string;
}

/**
 * One question's answer: the options chosen, by index into its own `options` (never by label — a
 * submission is validated against the stored question, not a string match), and any "Other" text.
 * generated from [ChatQuestionAnswer](../../../../apps/api/data/contracts/chat.ck)
 */
export interface ChatQuestionAnswer {
    chosen: number[];
    other?: string;
}

/**
 * generated from [RenameChatThreadRequest](../../../../apps/api/data/contracts/chat.ck)
 */
export interface RenameChatThreadRequest {
    title: string;
}

/**
 * An image sent in a chat. Metadata only, like `CardAttachment` and for its reason: the bytes come from
 * `GET .../attachments/{attachmentId}`. `contentType` is the type sniffed from the bytes, never the one
 * the uploader declared.
 * generated from [ChatAttachment](../../../../apps/api/data/contracts/chat.ck)
 */
export interface ChatAttachment {
    id: string;
    filename: string;
    contentType: string;
    byteSize: number;
    contentHash: string;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a ChatAttachment into its runtime type. Mutates and returns `raw`. */
export function reviveChatAttachment(raw: ChatAttachment): ChatAttachment {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'ChatAttachment.createdAt');
    return raw;
}

/**
 * Documentation, not validation, as `AttachImageUpload` is.
 * generated from [AttachChatImageUpload](../../../../apps/api/data/contracts/chat.ck)
 */
export interface AttachChatImageUpload {
    file: Blob;
}

/**
 * generated from [SendChatMessageRequest](../../../../apps/api/data/contracts/chat.ck)
 */
export interface SendChatMessageRequest {
    text: string;
    /** The project of the page the person is on, if any: the agent assumes it unless told otherwise. */
    project?: string;
}

/**
 * generated from [DecideChatActionRequest](../../../../apps/api/data/contracts/chat.ck)
 */
export interface DecideChatActionRequest {
    decision: 'confirm' | 'decline';
}

/**
 * generated from [ChatMessage](../../../../apps/api/data/contracts/chat.ck)
 */
export interface ChatMessage {
    seq: number;
    role: 'user' | 'assistant';
    /** Markdown, for an answer. */
    content: string;
    operations: ChatOperation[];
    createdAt: DateTime;
    /** What the answer offers to ask next, left out when it offers nothing. */
    suggestions?: string[];
}

/** Rehydrates every wire-encoded scalar in a ChatMessage into its runtime type. Mutates and returns `raw`. */
export function reviveChatMessage(raw: ChatMessage): ChatMessage {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'ChatMessage.createdAt');
    return raw;
}

/**
 * One of the 1-4 prompts an `ask_user` call asks together, as the agent asked it.
 * generated from [ChatQuestion](../../../../apps/api/data/contracts/chat.ck)
 */
export interface ChatQuestion {
    header: string;
    text: string;
    options: ChatQuestionOption[];
    multiSelect: boolean;
}

/**
 * `POST .../questions/{questionId}/answers`'s request: one answer per question asked, in order.
 * generated from [AnswerChatQuestionsRequest](../../../../apps/api/data/contracts/chat.ck)
 */
export interface AnswerChatQuestionsRequest {
    answers: ChatQuestionAnswer[];
}

/**
 * A question the agent asked, waiting on the person. `pending` until they answer it or an ordinary
 * message on the thread dismisses it (`ChatService.sendMessage`); `answered` once they submit. A
 * pending question past `expiresAt` can no longer be answered.
 * generated from [ChatPendingQuestion](../../../../apps/api/data/contracts/chat.ck)
 */
export interface ChatPendingQuestion {
    id: string;
    threadId: string;
    questions: ChatQuestion[];
    answers?: ChatQuestionAnswer[];
    status: 'pending' | 'answered' | 'dismissed';
    expiresAt: DateTime;
    decidedAt?: DateTime;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a ChatPendingQuestion into its runtime type. Mutates and returns `raw`. */
export function reviveChatPendingQuestion(raw: ChatPendingQuestion): ChatPendingQuestion {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['expiresAt'] = __dt(__o0['expiresAt'], 'ChatPendingQuestion.expiresAt');
    if (__o0['decidedAt'] != null) {
        __o0['decidedAt'] = __dt(__o0['decidedAt'], 'ChatPendingQuestion.decidedAt');
    }
    __o0['createdAt'] = __dt(__o0['createdAt'], 'ChatPendingQuestion.createdAt');
    return raw;
}

/**
 * generated from [ChatThreadDetail](../../../../apps/api/data/contracts/chat.ck)
 */
export interface ChatThreadDetail {
    thread: ChatThread;
    messages: ChatMessage[];
    actions: ChatPendingAction[];
    questions: ChatPendingQuestion[];
}

/** Rehydrates every wire-encoded scalar in a ChatThreadDetail into its runtime type. Mutates and returns `raw`. */
export function reviveChatThreadDetail(raw: ChatThreadDetail): ChatThreadDetail {
    const __o0 = raw as unknown as Record<string, unknown>;
    reviveChatThread(__o0['thread'] as never);
    {
        const __a1 = __o0['messages'] as unknown[];
        for (let __i2 = 0; __i2 < __a1.length; __i2++) {
            reviveChatMessage(__a1[__i2] as never);
        }
    }
    {
        const __a3 = __o0['actions'] as unknown[];
        for (let __i4 = 0; __i4 < __a3.length; __i4++) {
            reviveChatPendingAction(__a3[__i4] as never);
        }
    }
    {
        const __a5 = __o0['questions'] as unknown[];
        for (let __i6 = 0; __i6 < __a5.length; __i6++) {
            reviveChatPendingQuestion(__a5[__i6] as never);
        }
    }
    return raw;
}

/**
 * What one turn produced: the person's message as stored, the agent's answer, and any changes the
 * answer proposed. The answer streams over `GET /api/chat/threads/{id}/stream` while this request is
 * still open; this response is the stored record of it.
 * generated from [ChatTurnResult](../../../../apps/api/data/contracts/chat.ck)
 */
export interface ChatTurnResult {
    message: ChatMessage;
    reply: ChatMessage;
    proposed: ChatPendingAction[];
    asked: ChatPendingQuestion[];
}

/** Rehydrates every wire-encoded scalar in a ChatTurnResult into its runtime type. Mutates and returns `raw`. */
export function reviveChatTurnResult(raw: ChatTurnResult): ChatTurnResult {
    const __o0 = raw as unknown as Record<string, unknown>;
    reviveChatMessage(__o0['message'] as never);
    reviveChatMessage(__o0['reply'] as never);
    {
        const __a1 = __o0['proposed'] as unknown[];
        for (let __i2 = 0; __i2 < __a1.length; __i2++) {
            reviveChatPendingAction(__a1[__i2] as never);
        }
    }
    {
        const __a3 = __o0['asked'] as unknown[];
        for (let __i4 = 0; __i4 < __a3.length; __i4++) {
            reviveChatPendingQuestion(__a3[__i4] as never);
        }
    }
    return raw;
}
