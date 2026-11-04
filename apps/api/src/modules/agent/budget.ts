/**
 * Input-token budgeting, shared by both adapters.
 *
 * `maxOutputTokens` and `maxSteps` already bound a stage. Neither bounds input, and input is where
 * the cost is: one stage consumed 6.3M input tokens while its output cap held it to 50k. This is the
 * one place that arithmetic and its failure message live, so both adapters report the same thing
 * whichever engine ran.
 */

/** What the two kinds of cached input cost beside fresh input, which counts as 1. These mirror API pricing. */
export const CACHE_READ_WEIGHT = 0.1;
export const CACHE_WRITE_WEIGHT = 1.25;

/**
 * What a run's usage counts as against an input budget: its cost in fresh-input terms, rounded.
 *
 * Fresh input counts in full, a cache read at 0.1 and a cache write at 1.25. Adding them 1:1 measured
 * how long a conversation was rather than what it cost, because every turn resends all of it from the
 * cache. This is the only place the weights apply: a cap on a run or a card goes through here, and
 * stats keep showing raw tokens. A usage with no `cacheWriteInputTokens` counts everything cached as
 * reads, which covers both `codex` and every event recorded before writes were split out.
 *
 * The `cli` engine's `input_tokens` leaves caching out. On a real run it reported 2 per turn beside
 * 65,000 cached, so a cap on that figure alone could never be reached. `undefined` when no usage was
 * reported at all, which `overBudget` treats as nothing to judge.
 */
export const budgetedInputTokens = (
    usage: { inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number } | undefined,
): number | undefined => {
    if (usage?.inputTokens === undefined && usage?.cachedInputTokens === undefined) return undefined;
    const cached = usage.cachedInputTokens ?? 0;
    const written = usage.cacheWriteInputTokens ?? 0;
    return Math.round((usage.inputTokens ?? 0) + Math.max(0, cached - written) * CACHE_READ_WEIGHT + written * CACHE_WRITE_WEIGHT);
};

/**
 * The AI SDK's usage as a stage's `usage` holds it. Its `inputTokens` is everything sent, cached or
 * not, with the split in `inputTokenDetails`, where a stage's `inputTokens` leaves the cache out. The
 * sum stays the same. `undefined` input means the provider reported none, which stays unreported.
 */
export const stageUsageOf = (
    usage: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } } | undefined,
): { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number } => {
    if (usage?.inputTokens === undefined) return { inputTokens: undefined, outputTokens: usage?.outputTokens };
    const read = usage.inputTokenDetails?.cacheReadTokens ?? 0;
    const written = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    return {
        inputTokens: Math.max(0, usage.inputTokens - read - written),
        outputTokens: usage.outputTokens,
        cachedInputTokens: read + written,
        cacheWriteInputTokens: written,
    };
};

type ApiStepUsage = Parameters<typeof stageUsageOf>[0];

/** A run's steps as an input budget counts them, as far as usage was reported. */
export const budgetedStepTokens = (steps: readonly { usage?: ApiStepUsage }[]): number =>
    steps.reduce((total, step) => total + (budgetedInputTokens(stageUsageOf(step.usage)) ?? 0), 0);

/**
 * An AI SDK `stopWhen` condition: true once the run's budgeted input tokens meet `cap`.
 *
 * Sits in the same `stopWhen` array as `stepCountIs`, so a budget stage stops the loop the same way
 * running out of steps does.
 */
export const tokenBudgetExceeded =
    (cap: number) =>
    ({ steps }: { steps: readonly { usage?: ApiStepUsage }[] }): boolean =>
        budgetedStepTokens(steps) >= cap;

/**
 * A failure string naming both the cap and what was actually spent, or `undefined` when `used` is
 * still under `cap`.
 *
 * "Budget exceeded" tells an operator nothing about whether to raise the cap or shrink the card;
 * this names the figures so they don't have to go dig for them.
 */
export const overBudget = (used: number | undefined, cap: number): string | undefined => {
    if (used === undefined || used < cap) return undefined;
    return `input token budget exceeded: used ${used} cost-weighted, cap ${cap}`;
};

/**
 * A failure string naming the configured context-window fraction and the usage the engine
 * reported, or `undefined` when `percentage` is still under `capFraction`.
 *
 * Differs from `overBudget` in what it bounds. `overBudget` sums the cost-weighted input tokens a run has
 * already spent across every turn so far; this reads a single live number — `Query.getContextUsage()`'s
 * `percentage` — which already accounts for the whole conversation the *next* turn's prompt would
 * carry, tools and memory files included. A run can be comfortably under `maxInputTokens` and
 * still be one turn away from overflowing the window, because that cap only ever sees what has
 * already been spent, not what the next request is about to build on top of it.
 */
export const contextBudgetExceeded = (capFraction: number, percentage: number): string | undefined => {
    const capPercentage = capFraction * 100;
    if (percentage < capPercentage) return undefined;
    return `context window budget exceeded: cap ${capPercentage}% of window, observed ${percentage}%`;
};

/**
 * A failure string for a run aborted after exceeding its wall-clock budget.
 *
 * Distinct from `overBudget`: the abort fires at the cap itself, so there is no smaller "actual"
 * figure to report, and the cause is a different cap (`maxWallClockMs`, not `maxInputTokens`). A
 * stage cut off after a handful of steps by a timeout is not a stage that ran out of steps, and
 * reporting it as one sends an operator to raise the wrong number.
 */
export const wallClockExceeded = (capMs: number): string => `wall-clock budget exceeded: cap ${capMs}ms`;

/**
 * A run cut off by the step budget, naming what it actually spent.
 *
 * The denial count is part of the message on purpose: a stage that exhausted its steps having been
 * refused fifty times has a different problem from one that simply had too much to do, and the
 * operator cannot tell them apart from "used all its steps" alone.
 */
/**
 * A run abandoned because the engine stopped producing anything.
 *
 * Deliberately not a budget failure. A budget failure means the stage asked for more than it was
 * allowed; this means the engine died or wedged, which is an infrastructure fault the operator
 * should read as such. Reporting one as the other is the same misattribution that made a card burn
 * three retry cycles against an exhausted credit balance before anyone could see why.
 */
export const engineSilent = (capMs: number): string =>
    `the engine produced nothing for ${capMs}ms and was abandoned — it exited or wedged rather than running out of budget`;

export const stepsExceeded = (cap: number, denied: number): string =>
    denied > 0 ? `step budget exceeded: ${cap} steps, with ${denied} refused calls not charged against it` : `step budget exceeded: ${cap} steps`;
