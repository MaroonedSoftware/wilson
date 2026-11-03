import type { CreateReviewCommentRequest, ReviewComment, ReviewState } from './types/review.js';
import { reviveReviewComment, reviveReviewState } from './types/review.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [review.ck](../../../apps/api/data/contracts/review.ck)
 */
export class ReviewClient {
    constructor(private fetch: SdkFetch) {}

    /** @name Read a review */
    async readAReview(id: string): Promise<ReviewState> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/review`, { method: 'GET' });
        return reviveReviewState(await parseJson<ReviewState>(result));
    }

    /**
     * @name Open a review
     * @description Rejoins the review of the branch's current commit, or starts one, retiring any older open one.
     */
    async openAReview(id: string): Promise<ReviewState> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/review`, { method: 'POST' });
        return reviveReviewState(await parseJson<ReviewState>(result));
    }

    /** @name Add a review comment */
    async addAReviewComment(id: string, body: CreateReviewCommentRequest): Promise<ReviewComment> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/review/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveReviewComment(await parseJson<ReviewComment>(result));
    }

    /**
     * @name Resolve a review comment
     * @description A state the comment moves through rather than a delete. A comment already sent stays sent.
     */
    async resolveAReviewComment(id: string, commentId: string): Promise<ReviewComment> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/review/comments/${encodeURIComponent(commentId)}/resolve`, {
            method: 'POST',
        });
        return reviveReviewComment(await parseJson<ReviewComment>(result));
    }
}
