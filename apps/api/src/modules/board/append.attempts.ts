const HEADING = '## Previous attempts';

/** Longest a single failure's first line keeps before being cut, so one verbose failure cannot crowd out the rest of the bullet. */
const MAX_FAILURE_LENGTH = 200;

/** Most failures folded into one bullet — a stage that fails on many fronts at once still gets a short accounting, not a wall of text. */
const MAX_FAILURES_PER_BULLET = 5;

/**
 * One judged, failing run of a stage — the data `StageDispatcher.writeTransition` folds into a card's
 * `## Previous attempts` section so a stage retried after a kickback can read why its earlier attempts
 * failed, not just that they did. Today that history lives only in the `stage.failed` event payload,
 * which the next attempt never reads; this is the subset of it short enough to put in front of the
 * agent as part of its own plan file.
 *
 * Named after the fields `StageDispatcher` already has in hand at the point it fails a stage
 * (`outcome.failures`, `outcome.result?.summary`, `outcome.engineStopReason`, the kickback decision's
 * retry count, the stage's own `maxKickbacks`) rather than a new shape — nothing here is computed that
 * the dispatcher was not already computing for the event log.
 */
export interface Attempt {
    /** The stage that failed, e.g. `implementing`. */
    stage: string;
    /** This stage's attempt count after this failure — `KickbackDecision.retries[stage.name]`. */
    attempt: number;
    /** The stage's configured ceiling. `attempt` reaching this is what flags the card for a human instead of retrying again. */
    maxKickbacks: number;
    /** When the attempt failed, as an ISO timestamp. */
    date: string;
    /** Why the exit condition failed, in the order the checks ran — `StageOutcome.failures`. */
    failures: string[];
    /** The stage's own account of what it did, when it reported one. */
    summary?: string;
    /** The engine's own account of why its last message ended, when it said anything at all. */
    engineStopReason?: string;
    /**
     * Where this attempt's uncommitted work is preserved — `WorktreeManager.failedAttemptPatchPath`.
     * Already readable via `ScopeGuard.readableExtras`; nothing before this told the agent it exists.
     */
    patchPath?: string;
}

/** The first line of a (possibly multi-line) failure string, cut to `MAX_FAILURE_LENGTH`. */
const shorten = (failure: string): string => {
    const line = failure.split('\n', 1)[0] ?? '';
    return line.length > MAX_FAILURE_LENGTH ? `${line.slice(0, MAX_FAILURE_LENGTH)}…` : line;
};

/** One attempt as a single bullet: which stage, which attempt out of how many, and why it failed. */
const bullet = (attempt: Attempt): string => {
    const summary = attempt.summary && attempt.summary.trim().length > 0 ? attempt.summary.trim() : 'No summary reported.';
    const failures = attempt.failures.slice(0, MAX_FAILURES_PER_BULLET).map(shorten).join('; ');
    const engine = attempt.engineStopReason ? ` Engine stopped: ${attempt.engineStopReason}.` : '';
    const patch = attempt.patchPath ? ` Uncommitted work preserved at \`${attempt.patchPath}\`.` : '';
    return (
        `- **${attempt.stage}** attempt ${attempt.attempt} of ${attempt.maxKickbacks} (${attempt.date}): ${summary} ` +
        `Failures: ${failures}.${engine}${patch}`
    );
};

/**
 * Fold one more failed attempt into a card body under a `## Previous attempts` section.
 *
 * Not one of the plan-contract headings in `PLAN_SECTIONS` — like `## Review findings`
 * (`append.findings.ts`), this is runner-appended commentary, always found the same way. Unlike
 * findings, this section accumulates: a card kicked back three times carries three bullets, one per
 * attempt, each naturally bounded by the stage's own `maxKickbacks` — so the section can never grow
 * past the number of attempts the stage is even allowed. `withoutAttempts`, below, is the "shed on
 * pass" half of the same rule findings use, for the run that finally succeeds.
 *
 * Everything above and below the section is the original body's lines, untouched: only the section
 * itself — from its heading up to (not including) the next top-level heading, or the end of the body
 * — is replaced, exactly as `withFindings` does. Existing bullets are read back out of that section
 * (blank lines dropped, since the only blank lines a written section ever contains are the separators
 * this function and `withFindings` insert around it) and carried forward ahead of the new one, so nothing
 * already recorded is lost.
 */
export const withAttempt = (body: string, attempt: Attempt): string => {
    const lines = body.split('\n');
    const headingIndex = lines.findIndex(line => line.trim() === HEADING);

    const before = headingIndex === -1 ? lines : lines.slice(0, headingIndex);
    let existing: string[] = [];
    let after: string[] = [];
    if (headingIndex !== -1) {
        const rest = lines.slice(headingIndex + 1);
        const nextHeadingOffset = rest.findIndex(line => /^##\s+/.test(line));
        const sectionBody = nextHeadingOffset === -1 ? rest : rest.slice(0, nextHeadingOffset);
        existing = sectionBody.filter(line => line.trim() !== '');
        after = nextHeadingOffset === -1 ? [] : rest.slice(nextHeadingOffset);
    }

    const section = [HEADING, '', ...existing, bullet(attempt)];
    const needsLeadingBlank = before.length > 0 && before[before.length - 1]?.trim() !== '';
    const needsTrailingBlank = after.length > 0;

    return [...before, ...(needsLeadingBlank ? [''] : []), ...section, ...(needsTrailingBlank ? [''] : []), ...after].join('\n');
};

/**
 * Remove the `## Previous attempts` section entirely — how a card that finally passes the stage that
 * kept kicking it back sheds the complaints from every attempt before this one. A body with no such
 * section round-trips unchanged, the same guarantee `withFindings` gives an empty `findings` array.
 */
export const withoutAttempts = (body: string): string => {
    const lines = body.split('\n');
    const headingIndex = lines.findIndex(line => line.trim() === HEADING);
    if (headingIndex === -1) return body;

    const before = lines.slice(0, headingIndex);
    const rest = lines.slice(headingIndex + 1);
    const nextHeadingOffset = rest.findIndex(line => /^##\s+/.test(line));
    const after = nextHeadingOffset === -1 ? [] : rest.slice(nextHeadingOffset);

    return [...before, ...after].join('\n');
};
