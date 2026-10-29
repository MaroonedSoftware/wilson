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
 * generated from [RenameChatThreadRequest](../../../../apps/api/data/contracts/chat.ck)
 */
export interface RenameChatThreadRequest {
    title: string;
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
}

/** Rehydrates every wire-encoded scalar in a ChatMessage into its runtime type. Mutates and returns `raw`. */
export function reviveChatMessage(raw: ChatMessage): ChatMessage {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'ChatMessage.createdAt');
    return raw;
}

/**
 * generated from [ChatThreadDetail](../../../../apps/api/data/contracts/chat.ck)
 */
export interface ChatThreadDetail {
    thread: ChatThread;
    messages: ChatMessage[];
    actions: ChatPendingAction[];
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
    return raw;
}
