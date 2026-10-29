import { useEffect, useState, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatOperation, ChatPendingAction, ChatThread, ChatTurnResult } from '@wilson/sdk';
import { API_BASE } from './sdk.js';
import { useWilsonSdk } from './sdk-context.js';

export const CHAT_THREADS_KEY = ['chat-threads'] as const;
export const chatThreadKey = (id: string) => ['chat-thread', id] as const;

/** The person's chat threads, most recently active first. */
export function useChatThreads(enabled: boolean) {
    const wilson = useWilsonSdk();
    return useQuery({ queryKey: CHAT_THREADS_KEY, queryFn: () => wilson.chat.listChatThreads(), enabled });
}

/** One thread with its messages and the changes it proposed. Undefined `id` reads nothing. */
export function useChatThread(id: string | undefined) {
    const wilson = useWilsonSdk();
    return useQuery({ queryKey: chatThreadKey(id ?? ''), queryFn: () => wilson.chat.getAChatThread(id!), enabled: id !== undefined });
}

/** Starts an empty thread; its first message names it. */
export function useStartChatThread() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (): Promise<ChatThread> => wilson.chat.startAChatThread(),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: CHAT_THREADS_KEY }),
    });
}

/**
 * Sends a message and answers with the stored turn once the chat has answered it; the answer streams
 * in through {@link useChatStream} meanwhile. A refusal is left on `error` for the composer to show
 * beside what was typed.
 */
export function useSendChatMessage() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ threadId, text, project }: { threadId: string; text: string; project?: string }): Promise<ChatTurnResult> =>
            wilson.chat.sendAChatMessage(threadId, { text, ...(project ? { project } : {}) }),
        onSettled: (_result, _error, { threadId }) => {
            void queryClient.invalidateQueries({ queryKey: chatThreadKey(threadId) });
            void queryClient.invalidateQueries({ queryKey: CHAT_THREADS_KEY });
        },
    });
}

/**
 * Confirms or declines a proposed change. A confirm may have changed anything the app shows (a
 * card's stage, a setting), and the chat cannot know which queries that touched, so it invalidates
 * every query rather than guessing; the board's own feed would catch up anyway, a moment later.
 */
export function useDecideChatAction(threadId: string | undefined) {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ actionId, decision }: { actionId: string; decision: 'confirm' | 'decline' }): Promise<ChatPendingAction> =>
            wilson.chat.decideAChatAction(actionId, { decision }),
        onSettled: (_result, _error, { decision }) => {
            if (decision === 'confirm') void queryClient.invalidateQueries();
            else if (threadId) void queryClient.invalidateQueries({ queryKey: chatThreadKey(threadId) });
        },
    });
}

export function useArchiveChatThread() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string): Promise<ChatThread> => wilson.chat.archiveAChatThread(id),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: CHAT_THREADS_KEY }),
    });
}

/** What a turn still being answered has sent so far: its text, and the reads it has run. */
export interface ChatTurnInProgress {
    text: string;
    operations: ChatOperation[];
}

/**
 * Listens to a thread's turn in progress (`GET /api/chat/threads/{id}/stream`, `routes.setup.ts`'s
 * `ChatStreamRouter`). The stream is ephemeral and the stored thread is the record: on `done` or
 * `failed` this clears what it gathered and refetches the thread, which by then holds the answer.
 * Undefined `threadId` opens nothing.
 */
export function useChatStream(threadId: string | undefined): ChatTurnInProgress {
    const queryClient = useQueryClient();
    const [text, setText] = useState('');
    const [operations, setOperations] = useState<ChatOperation[]>([]);

    useEffect(() => {
        setText('');
        setOperations([]);
        if (!threadId) return;

        // `withCredentials`: authenticated by the API's stream cookie, as the board feed's stream is.
        const source = new EventSource(`${API_BASE}/api/chat/threads/${encodeURIComponent(threadId)}/stream`, { withCredentials: true });
        const finish = () => {
            setText('');
            setOperations([]);
            void queryClient.invalidateQueries({ queryKey: chatThreadKey(threadId) });
        };
        source.addEventListener('delta', event => setText(previous => previous + (event as MessageEvent<string>).data));
        source.addEventListener('operation', event => {
            const operation = JSON.parse((event as MessageEvent<string>).data) as ChatOperation;
            setOperations(previous => [...previous, operation]);
        });
        source.addEventListener('proposed', () => void queryClient.invalidateQueries({ queryKey: chatThreadKey(threadId) }));
        source.addEventListener('done', finish);
        source.addEventListener('failed', finish);

        return () => source.close();
    }, [threadId, queryClient]);

    return { text, operations };
}

const ACTIVE_THREAD_KEY = 'wilson.chatThread';

const readActiveThread = (): string | undefined => {
    try {
        return window.localStorage.getItem(ACTIVE_THREAD_KEY) ?? undefined;
    } catch {
        return undefined;
    }
};

let activeThread = readActiveThread();
const activeThreadListeners = new Set<() => void>();

/**
 * Open `threadId` wherever the chat is showing — the home page and the dock read the same one, as in
 * ats's `active.thread.store.ts` — or none, for a new chat. Kept in `localStorage` (a per-browser
 * convenience, so a reload reopens the conversation), and every reader is told at once.
 */
export function setActiveThread(threadId: string | undefined): void {
    if (activeThread === threadId) return;
    activeThread = threadId;
    try {
        if (threadId === undefined) window.localStorage.removeItem(ACTIVE_THREAD_KEY);
        else window.localStorage.setItem(ACTIVE_THREAD_KEY, threadId);
    } catch {
        // Storage can be unavailable (a private window); the thread stays open for this page load.
    }
    for (const listener of activeThreadListeners) listener();
}

/** The thread the chat has open, if any. */
export function useActiveThread(): string | undefined {
    return useSyncExternalStore(
        listener => {
            activeThreadListeners.add(listener);
            return () => activeThreadListeners.delete(listener);
        },
        () => activeThread,
    );
}
