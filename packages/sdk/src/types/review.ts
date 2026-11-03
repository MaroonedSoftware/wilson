import { DateTime } from 'luxon';
const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * A place one step of a tour points at. `in-diff` can be jumped to. `outside-diff` is real code the change
 * didn't touch, and `truncated` is in a file whose diff is too large to show, so both are only a label.
 * generated from [ReviewTourAnchor](../../../../apps/api/data/contracts/review.ck)
 */
export interface ReviewTourAnchor {
    file: string;
    side: 'old' | 'new';
    startLine: number;
    endLine: number;
    status: 'in-diff' | 'outside-diff' | 'truncated';
}

/**
 * `line` is where the comment was written, at commit `head`. `location` and `currentLine` say where it is
 * now: `outdated` means its line can no longer be told apart in the branch's current diff.
 * generated from [ReviewComment](../../../../apps/api/data/contracts/review.ck)
 */
export interface ReviewComment {
    id: string;
    reviewId: string;
    head: string;
    file: string;
    side: 'old' | 'new';
    line: number;
    lineText: string;
    severity: 'blocker' | 'concern';
    text: string;
    status: 'open' | 'resolved' | 'sent';
    location: 'found' | 'outdated';
    currentLine?: number;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a ReviewComment into its runtime type. Mutates and returns `raw`. */
export function reviveReviewComment(raw: ReviewComment): ReviewComment {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'ReviewComment.createdAt');
    return raw;
}

/**
 * `head` is the commit the person was looking at. A mismatch is a 409, so a comment never lands on a line
 * the person did not see. `severity` left out means `blocker`.
 * generated from [CreateReviewCommentRequest](../../../../apps/api/data/contracts/review.ck)
 */
export interface CreateReviewCommentRequest {
    head: string;
    file: string;
    side: 'old' | 'new';
    line: number;
    severity?: 'blocker' | 'concern';
    text: string;
}

/**
 * `head` is the commit the person was looking at, as in `CreateReviewCommentRequest`.
 * generated from [ReviewVerdictRequest](../../../../apps/api/data/contracts/review.ck)
 */
export interface ReviewVerdictRequest {
    head: string;
}

/**
 * One turn of the review's conversation. A person's holds exactly what they typed.
 * generated from [ReviewTurn](../../../../apps/api/data/contracts/review.ck)
 */
export interface ReviewTurn {
    seq: number;
    role: 'user' | 'assistant';
    content: string;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a ReviewTurn into its runtime type. Mutates and returns `raw`. */
export function reviveReviewTurn(raw: ReviewTurn): ReviewTurn {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'ReviewTurn.createdAt');
    return raw;
}

/**
 * `head` is the commit the person was looking at, as in `CreateReviewCommentRequest`. `mode: tour` asks the
 * agent to write the tour as well as answer. `stepIndex` is the 0-based step of the tour on screen, so a
 * question can be about "this".
 * generated from [ReviewTurnRequest](../../../../apps/api/data/contracts/review.ck)
 */
export interface ReviewTurnRequest {
    head: string;
    text: string;
    mode?: 'chat' | 'tour';
    stepIndex?: number;
}

/**
 * generated from [ReviewTourStep](../../../../apps/api/data/contracts/review.ck)
 */
export interface ReviewTourStep {
    title: string;
    /** Markdown. */
    explanation: string;
    anchors: ReviewTourAnchor[];
}

/**
 * `stale` is true once the branch has moved past `head`. `tour` is left out until the agent has written one.
 * generated from [Review](../../../../apps/api/data/contracts/review.ck)
 */
export interface Review {
    id: string;
    head: string;
    base: string;
    status: 'open' | 'changes_requested' | 'approved' | 'superseded';
    stale: boolean;
    createdAt: DateTime;
    verdictAt?: DateTime;
    tour?: ReviewTourStep[];
}

/** Rehydrates every wire-encoded scalar in a Review into its runtime type. Mutates and returns `raw`. */
export function reviveReview(raw: Review): Review {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'Review.createdAt');
    if (__o0['verdictAt'] != null) {
        __o0['verdictAt'] = __dt(__o0['verdictAt'], 'Review.verdictAt');
    }
    return raw;
}

/**
 * `review` is left out for a card nobody has reviewed yet. `comments` holds every review's, oldest first.
 * generated from [ReviewState](../../../../apps/api/data/contracts/review.ck)
 */
export interface ReviewState {
    review?: Review;
    comments: ReviewComment[];
}

/** Rehydrates every wire-encoded scalar in a ReviewState into its runtime type. Mutates and returns `raw`. */
export function reviveReviewState(raw: ReviewState): ReviewState {
    const __o0 = raw as unknown as Record<string, unknown>;
    if (__o0['review'] != null) {
        reviveReview(__o0['review'] as never);
    }
    {
        const __a1 = __o0['comments'] as unknown[];
        for (let __i2 = 0; __i2 < __a1.length; __i2++) {
            reviveReviewComment(__a1[__i2] as never);
        }
    }
    return raw;
}
