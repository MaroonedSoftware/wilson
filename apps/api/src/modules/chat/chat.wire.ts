import type { ChatMessage as WireChatMessage, ChatPendingAction as WirePendingAction, ChatThread as WireChatThread } from '#src/generated/chat.js';
import type { ChatMessage } from './chat.message.repository.js';
import type { PendingAction } from './chat.pending.action.repository.js';
import type { ChatThread } from './chat.thread.repository.js';

/** The chat's rows as `chat.ck` sends them: optional fields left out rather than undefined, and no engine-only state. */
export const toWireThread = (thread: ChatThread): WireChatThread => ({
    id: thread.id,
    title: thread.title,
    engine: thread.engine,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(thread.archivedAt ? { archivedAt: thread.archivedAt } : {}),
});

export const toWireMessage = (message: ChatMessage): WireChatMessage => ({
    seq: message.seq,
    role: message.role,
    content: message.content,
    operations: message.operations.map(operation => ({
        ...operation,
        arguments: operation.arguments as WireChatMessage['operations'][number]['arguments'],
    })),
    createdAt: message.createdAt,
});

export const toWireAction = (action: PendingAction): WirePendingAction => ({
    id: action.id,
    threadId: action.threadId,
    operation: action.operation,
    arguments: action.arguments as WirePendingAction['arguments'],
    summary: action.summary,
    status: action.status,
    expiresAt: action.expiresAt,
    createdAt: action.createdAt,
    ...(action.project ? { project: action.project } : {}),
    ...(action.result !== undefined ? { result: action.result as WirePendingAction['result'] } : {}),
    ...(action.error ? { error: action.error } : {}),
    ...(action.decidedAt ? { decidedAt: action.decidedAt } : {}),
});
