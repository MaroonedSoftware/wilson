import type { AttachContextRequest, ContextSnapshot } from './types/context.js';
import { reviveContextSnapshot } from './types/context.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

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
}
