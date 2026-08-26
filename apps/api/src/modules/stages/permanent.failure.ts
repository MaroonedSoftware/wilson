/**
 * Signatures of a failure that retrying cannot fix.
 *
 * Deliberately conservative and matched on message text, because the SDK and the provider surface
 * these as ordinary errors with no stable machine-readable class. A miss here costs a few wasted
 * retries; a false positive strands a card that would have recovered, so the patterns name only
 * conditions that are certainly about credentials, entitlement or a malformed request.
 */
const PERMANENT = [
    /credit balance is too low/i,
    /not logged in/i,
    /invalid[_ ]request[_ ]error/i,
    /authentication[_ ]error/i,
    /permission[_ ]error/i,
    /\b401\b|\b403\b/,
    // A rebase that cannot be replayed will not replay on the next attempt either.
    /rebase conflict/i,
];

/**
 * Whether an error will fail identically however many times it is retried.
 *
 * pg-boss retries a thrown job under the queue's policy, which is right for a timeout or a dropped
 * connection and pure waste for an exhausted balance. This session watched a card burn three retry
 * cycles against "credit balance is too low", each one dispatching a stage, cutting a worktree and
 * installing dependencies before failing at the first model call.
 */
export const isPermanentFailure = (error: unknown): boolean => {
    const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error);
    return PERMANENT.some(pattern => pattern.test(message));
};

/**
 * The provider's own text for a prompt that no longer fits the model's context window.
 *
 * Narrower than `PERMANENT`'s `/invalid[_ ]request[_ ]error/i` on purpose (card 0072): an overflow
 * shares that error class, but it is not the same kind of never as an exhausted balance or a missing
 * credential. Those are facts about the deployment, true for every card that arrives. An overflow is
 * a fact about how big this card's stage got, and it is recoverable by doing the stage differently —
 * a fresh session on the same branch, or a smaller card — so it must never fall through to
 * `isPermanentFailure` and be poisoned alongside the things that really cannot recover.
 */
const CONTEXT_OVERFLOW_TEXT = /prompt is too long/i;

/**
 * The reason an operator sees when a stage is flagged for exactly this cause. Names the context
 * window, not the request, so the flag reads as "split the card" rather than "bug in the runner".
 */
export const CONTEXT_OVERFLOW_REASON = "prompt is too long — this stage's context exceeded the model's window";

/**
 * Whether a failure is specifically a context-window overflow, not just any `invalid_request_error`.
 *
 * Matched on the error class *and* the provider's "prompt is too long" wording together, so this
 * claims only the overflow case and leaves every other malformed request for `isPermanentFailure` to
 * classify exactly as it does today. Must be checked before `isPermanentFailure` — see
 * `classifyDispatchFailure`'s ordering — or the broader pattern claims the message first and the
 * card is poisoned instead of flagged for a human.
 */
export const isContextOverflow = (error: unknown): boolean => {
    const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error);
    return /invalid[_ ]request[_ ]error/i.test(message) && CONTEXT_OVERFLOW_TEXT.test(message);
};
