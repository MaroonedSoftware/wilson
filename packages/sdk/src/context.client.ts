import type { AttachContextRequest, CardAttachment, ContextSnapshot } from './types/context.js';
import { reviveCardAttachment, reviveContextSnapshot } from './types/context.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, readContentType } from './sdk-options.js';

/**
 * generated from [context.ck](../../../apps/api/data/contracts/context.ck)
 */
export class ContextClient {
    constructor(private fetch: SdkFetch) {}

    /** @name Attach context to a card */
    async attachContextToACard(id: string, body: AttachContextRequest): Promise<ContextSnapshot> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/context`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveContextSnapshot(await parseJson<ContextSnapshot>(result));
    }

    /** @name List card context */
    async listCardContext(id: string): Promise<ContextSnapshot[]> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/context`, { method: 'GET' });
        return (await parseJson<ContextSnapshot[]>(result)).map(reviveContextSnapshot);
    }

    /**
     * @name Remove a context snapshot
     * @description `delete`, not `post .../remove`: contractkit emits a DELETE handler like any other method, so
     * there is no reason to reach for the `/resolve`-style action suffix `board.ck` uses only where the
     * verb genuinely isn't one of the four HTTP methods this repo's contracts use elsewhere. A snapshot
     * has no history worth keeping once removed (`CardContextRepository.remove`'s own doc comment), so
     * unlike `.../plan/comments/{commentId}/resolve` this is a real delete, not a state transition.
     */
    async removeAContextSnapshot(id: string, contextId: string): Promise<void> {
        await this.fetch(`/api/cards/${encodeURIComponent(id)}/context/${encodeURIComponent(contextId)}`, { method: 'DELETE' });
    }

    /** @name Attach an image to a card */
    async attachAnImageToACard(id: string, body: FormData): Promise<CardAttachment> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/attachments`, {
            method: 'POST',
            body: body,
        });
        return reviveCardAttachment(await parseJson<CardAttachment>(result));
    }

    /** @name List card attachments */
    async listCardAttachments(id: string): Promise<CardAttachment[]> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/attachments`, { method: 'GET' });
        return (await parseJson<CardAttachment[]>(result)).map(reviveCardAttachment);
    }

    /**
     * @name Fetch an attachment
     * @description `attachmentId`, not a second `id`, for the reason `{contextId}` above has: a `params` block is keyed
     * by name. Nesting under the card lets one 404 cover a card that does not exist and an attachment id
     * that does not exist, belongs to another card, or is not an id at all.
     */
    async fetchAnAttachment(
        id: string,
        attachmentId: string,
    ): Promise<{
        contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
        data: Blob;
        headers: { xContentTypeOptions: string; contentSecurityPolicy: string };
    }> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'GET' });
        return {
            contentType: readContentType(result) as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
            data: await result.blob(),
            headers: {
                xContentTypeOptions: result.headers.get('x-content-type-options')!,
                contentSecurityPolicy: result.headers.get('content-security-policy')!,
            },
        };
    }

    /**
     * @name Remove an attachment
     * @description `attachmentId`, not a second `id`, for the reason `{contextId}` above has: a `params` block is keyed
     * by name. Nesting under the card lets one 404 cover a card that does not exist and an attachment id
     * that does not exist, belongs to another card, or is not an id at all.
     */
    async removeAnAttachment(id: string, attachmentId: string): Promise<void> {
        await this.fetch(`/api/cards/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' });
    }
}
