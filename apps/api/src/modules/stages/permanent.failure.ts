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
