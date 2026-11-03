import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * A place one step of a tour points at. `in-diff` can be jumped to. `outside-diff` is real code the change
 * didn't touch, and `truncated` is in a file whose diff is too large to show, so both are only a label.
 * generated from [ReviewTourAnchor](../../data/contracts/review.ck)
 */
export const ReviewTourAnchor = z.strictObject({
    file: z.string(),
    side: z.enum(['old', 'new']),
    startLine: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    endLine: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    status: z.enum(['in-diff', 'outside-diff', 'truncated']),
});
export type ReviewTourAnchor = z.infer<typeof ReviewTourAnchor>;

/**
 * `line` is where the comment was written, at commit `head`. `location` and `currentLine` say where it is
 * now: `outdated` means its line can no longer be told apart in the branch's current diff.
 * generated from [ReviewComment](../../data/contracts/review.ck)
 */
export const ReviewComment = z.strictObject({
    id: z.string(),
    reviewId: z.string(),
    head: z.string(),
    file: z.string(),
    side: z.enum(['old', 'new']),
    line: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    lineText: z.string(),
    severity: z.enum(['blocker', 'concern']),
    text: z.string(),
    status: z.enum(['open', 'resolved', 'sent']),
    location: z.enum(['found', 'outdated']),
    currentLine: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    createdAt: _ZodDatetime,
});
export type ReviewComment = z.infer<typeof ReviewComment>;

/**
 * `head` is the commit the person was looking at. A mismatch is a 409, so a comment never lands on a line
 * the person did not see. `severity` left out means `blocker`.
 * generated from [CreateReviewCommentRequest](../../data/contracts/review.ck)
 */
export const CreateReviewCommentRequest = z.strictObject({
    head: z.string(),
    file: z.string(),
    side: z.enum(['old', 'new']),
    line: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    severity: z.enum(['blocker', 'concern']).optional(),
    text: z.string(),
});
export type CreateReviewCommentRequest = z.infer<typeof CreateReviewCommentRequest>;

/**
 * `head` is the commit the person was looking at, as in `CreateReviewCommentRequest`.
 * generated from [ReviewVerdictRequest](../../data/contracts/review.ck)
 */
export const ReviewVerdictRequest = z.strictObject({
    head: z.string(),
});
export type ReviewVerdictRequest = z.infer<typeof ReviewVerdictRequest>;

/**
 * One turn of the review's conversation. A person's holds exactly what they typed.
 * generated from [ReviewTurn](../../data/contracts/review.ck)
 */
export const ReviewTurn = z.strictObject({
    seq: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    createdAt: _ZodDatetime,
});
export type ReviewTurn = z.infer<typeof ReviewTurn>;

/**
 * `head` is the commit the person was looking at, as in `CreateReviewCommentRequest`. `mode: tour` asks the
 * agent to write the tour as well as answer. `stepIndex` is the 0-based step of the tour on screen, so a
 * question can be about "this".
 * generated from [ReviewTurnRequest](../../data/contracts/review.ck)
 */
export const ReviewTurnRequest = z.strictObject({
    head: z.string(),
    text: z.string(),
    mode: z.enum(['chat', 'tour']).optional(),
    stepIndex: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
});
export type ReviewTurnRequest = z.infer<typeof ReviewTurnRequest>;

/**
 * generated from [ReviewTourStep](../../data/contracts/review.ck)
 */
export const ReviewTourStep = z.strictObject({
    title: z.string(),
    explanation: z.string().describe('Markdown.'),
    anchors: z.array(ReviewTourAnchor),
});
export type ReviewTourStep = z.infer<typeof ReviewTourStep>;

/**
 * `stale` is true once the branch has moved past `head`. `tour` is left out until the agent has written one.
 * generated from [Review](../../data/contracts/review.ck)
 */
export const Review = z.strictObject({
    id: z.string(),
    head: z.string(),
    base: z.string(),
    status: z.enum(['open', 'changes_requested', 'approved', 'superseded']),
    stale: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
    createdAt: _ZodDatetime,
    verdictAt: _ZodDatetime.optional(),
    tour: z.array(ReviewTourStep).optional(),
});
export type Review = z.infer<typeof Review>;

/**
 * `review` is left out for a card nobody has reviewed yet. `comments` holds every review's, oldest first.
 * generated from [ReviewState](../../data/contracts/review.ck)
 */
export const ReviewState = z.strictObject({
    review: Review.optional(),
    comments: z.array(ReviewComment),
});
export type ReviewState = z.infer<typeof ReviewState>;
