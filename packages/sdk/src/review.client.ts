import type { CreateReviewCommentRequest, ReviewComment, ReviewState, ReviewTurn, ReviewTurnRequest, ReviewVerdictRequest } from './types/review.js';
import { reviveReviewComment, reviveReviewState, reviveReviewTurn } from './types/review.js';
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

    /**
     * @name Request changes
     * @description Sends every open comment to `ready`'s `onFail` stage as findings, and moves the card there. Comments are
     * marked `sent`, so a later review re-locates them but does not send them again.
     */
    async requestChanges(id: string, body: ReviewVerdictRequest): Promise<ReviewState> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/review/request-changes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveReviewState(await parseJson<ReviewState>(result));
    }

    /**
     * @name Approve a review
     * @description Records the person's approval of the branch at `head`. The card stays where it is and merging is not
     * gated on this. An open blocker refuses it; an open concern does not.
     */
    async approveAReview(id: string, body: ReviewVerdictRequest): Promise<ReviewState> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/review/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveReviewState(await parseJson<ReviewState>(result));
    }

    /**
     * @name List review turns
     * @description The conversation with the agent walking the person through the change. It reads committed code at the
     * review's commit and has no way to change anything. A turn's answer arrives as it is written over
     * `GET .../review/stream`, a hand-built route in `routes.setup.ts` because this file can't describe a
     * response that never resolves. It sends `delta`, then `done` or `failed`.
     */
    async listReviewTurns(id: string): Promise<ReviewTurn[]> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/review/turns`, { method: 'GET' });
        return (await parseJson<ReviewTurn[]>(result)).map(reviveReviewTurn);
    }

    /**
     * @name Send a review turn
     * @description The conversation with the agent walking the person through the change. It reads committed code at the
     * review's commit and has no way to change anything. A turn's answer arrives as it is written over
     * `GET .../review/stream`, a hand-built route in `routes.setup.ts` because this file can't describe a
     * response that never resolves. It sends `delta`, then `done` or `failed`.
     */
    async sendAReviewTurn(id: string, body: ReviewTurnRequest): Promise<ReviewTurn> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/review/turns`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveReviewTurn(await parseJson<ReviewTurn>(result));
    }
}
