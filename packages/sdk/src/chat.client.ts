import type {
    ChatPendingAction,
    ChatThread,
    ChatThreadDetail,
    ChatTurnResult,
    DecideChatActionRequest,
    RenameChatThreadRequest,
    SendChatMessageRequest,
} from './types/chat.js';
import { reviveChatPendingAction, reviveChatThread, reviveChatThreadDetail, reviveChatTurnResult } from './types/chat.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [chat.ck](../../../apps/api/data/contracts/chat.ck)
 */
export class ChatClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List chat threads */
    async listChatThreads(): Promise<ChatThread[]> {
        const result = await this.fetch(`/api/chat/threads`, { method: 'GET' });
        return (await parseJson<ChatThread[]>(result)).map(reviveChatThread);
    }

    /**
     * @name Start a chat thread
     * @description Starts an empty thread on the engine the `chat-engine` setting names now; its first message
     * names it.
     */
    async startAChatThread(): Promise<ChatThread> {
        const result = await this.fetch(`/api/chat/threads`, { method: 'POST' });
        return reviveChatThread(await parseJson<ChatThread>(result));
    }

    /** @name Get a chat thread */
    async getAChatThread(id: string): Promise<ChatThreadDetail> {
        const result = await this.fetch(`/api/chat/threads/${encodeURIComponent(id)}`, { method: 'GET' });
        return reviveChatThreadDetail(await parseJson<ChatThreadDetail>(result));
    }

    /** @name Rename a chat thread */
    async renameAChatThread(id: string, body: RenameChatThreadRequest): Promise<ChatThread> {
        const result = await this.fetch(`/api/chat/threads/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveChatThread(await parseJson<ChatThread>(result));
    }

    /**
     * @name Archive a chat thread
     * @description Archiving takes a thread out of the list; its messages stay.
     */
    async archiveAChatThread(id: string): Promise<ChatThread> {
        const result = await this.fetch(`/api/chat/threads/${encodeURIComponent(id)}/archive`, { method: 'POST' });
        return reviveChatThread(await parseJson<ChatThread>(result));
    }

    /**
     * @name Send a chat message
     * @description Runs one turn and answers once it is stored. A turn that cannot run (no API key for the engine's
     * provider, say) answers 502 with the reason, and the person's message is kept.
     */
    async sendAChatMessage(id: string, body: SendChatMessageRequest): Promise<ChatTurnResult> {
        const result = await this.fetch(`/api/chat/threads/${encodeURIComponent(id)}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveChatTurnResult(await parseJson<ChatTurnResult>(result));
    }

    /**
     * @name Decide a chat action
     * @description Confirm runs the proposed operation, at most once however many times it is sent, and answers with
     * how it went: a failed operation is a 200 with `status: failed` and its `error`, since the decision
     * itself succeeded. A proposal already decided, or expired, is a 409.
     */
    async decideAChatAction(id: string, body: DecideChatActionRequest): Promise<ChatPendingAction> {
        const result = await this.fetch(`/api/chat/actions/${encodeURIComponent(id)}/decision`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveChatPendingAction(await parseJson<ChatPendingAction>(result));
    }
}
