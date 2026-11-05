import type {
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
} from './types/chat.js';
import {
    reviveChatAttachment,
    reviveChatPendingAction,
    reviveChatPendingQuestion,
    reviveChatThread,
    reviveChatThreadDetail,
    reviveChatTurnResult,
} from './types/chat.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, readContentType } from './sdk-options.js';

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
     * provider, say) answers 503 with the reason, and the person's message is kept. Not 502: Cloudflare
     * replaces an origin's 502 with its own page, and the reason goes with it.
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
     * @name Upload a chat image
     * @description An image goes up before the message that carries it, so a message's send stays JSON. One that no
     * message claims is removed a day later.
     */
    async uploadAChatImage(id: string, body: FormData): Promise<ChatAttachment> {
        const result = await this.fetch(`/api/chat/threads/${encodeURIComponent(id)}/attachments`, {
            method: 'POST',
            body: body,
        });
        return reviveChatAttachment(await parseJson<ChatAttachment>(result));
    }

    /**
     * @name Fetch a chat image
     * @description `attachmentId`, not a second `id`: a `params` block is keyed by name. One 404 covers a thread that
     * does not exist and an attachment id that does not exist, belongs to another thread, or is not an id.
     */
    async fetchAChatImage(
        id: string,
        attachmentId: string,
    ): Promise<{
        contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml';
        data: Blob;
        headers: { xContentTypeOptions: string; contentSecurityPolicy: string };
    }> {
        const result = await this.fetch(`/api/chat/threads/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`, {
            method: 'GET',
        });
        return {
            contentType: readContentType(result) as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml',
            data: await result.blob(),
            headers: {
                xContentTypeOptions: result.headers.get('x-content-type-options')!,
                contentSecurityPolicy: result.headers.get('content-security-policy')!,
            },
        };
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

    /**
     * @name Answer chat questions
     * @description Answers a question `ask_user` asked, choosing options by index and/or typing free text under
     * "Other". A valid submission moves the row to `answered` and starts a follow-up turn on the thread,
     * carrying the chosen labels and any "Other" text as a note from Wilson — the same mechanism a
     * confirmed change already uses (`POST .../decision`) — never a `role: 'user'` message in the
     * person's name. The second path param is `questionId`, not `id`: contractkit keys a `params` block
     * by name, so two `{id}` segments in one path cannot be expressed (see `.../context/{contextId}` in
     * `context.ck` and `.../comments/{commentId}/resolve` in `board.ck` for the same shape). One
     * consequence of nesting under the thread, which is the point of it: the same 404 below covers either
     * id not existing — the thread, or a question id that does not belong to it.
     */
    async answerChatQuestions(id: string, questionId: string, body: AnswerChatQuestionsRequest): Promise<ChatPendingQuestion> {
        const result = await this.fetch(`/api/chat/threads/${encodeURIComponent(id)}/questions/${encodeURIComponent(questionId)}/answers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveChatPendingQuestion(await parseJson<ChatPendingQuestion>(result));
    }
}
