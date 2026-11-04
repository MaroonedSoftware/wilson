/**
 * The `retries` key {@link BoardWriteService.reReviewOnOverlap} counts its send-backs under —
 * distinct from `review`, the stage name itself, so this check's bookkeeping never touches
 * `review`'s own `maxKickbacks` counter. Follows `kickback.ts`'s `droppedRetryKey` naming: `<the
 * stage it routes to>:<what this counter is>`.
 */
export const RE_REVIEW_RETRY_KEY = 'review:re-review';

/**
 * How many times {@link BoardWriteService.reReviewOnOverlap} sends a card back to `review` for the
 * same reason before giving up and flagging a human. Small and fixed, the same posture
 * `RESULT_DROPPED_ALLOWANCE` (`kickback.ts`) takes for its own bounded allowance: a card whose
 * files keep colliding with what lands on `main` is not making progress by retrying forever.
 */
export const RE_REVIEW_CAP = 2;
