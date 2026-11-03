import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * `stale` is true once the branch has moved past `head`.
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
});
export type Review = z.infer<typeof Review>;

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
 * `review` is left out for a card nobody has reviewed yet. `comments` holds every review's, oldest first.
 * generated from [ReviewState](../../data/contracts/review.ck)
 */
export const ReviewState = z.strictObject({
    review: Review.optional(),
    comments: z.array(ReviewComment),
});
export type ReviewState = z.infer<typeof ReviewState>;
