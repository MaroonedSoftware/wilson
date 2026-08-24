/**
 * Input-token budgeting, shared by both adapters.
 *
 * `maxOutputTokens` and `maxSteps` already bound a stage. Neither bounds input, and input is where
 * the cost is: one stage consumed 6.3M input tokens while its output cap held it to 50k. This is the
 * one place that arithmetic and its failure message live, so both adapters report the same thing
 * whichever engine ran.
 */

/** Cumulative input tokens across a run's steps, as far as usage was reported. */
export const sumInputTokens = (steps: readonly { usage?: { inputTokens?: number } }[]): number =>
    steps.reduce((total, step) => total + (step.usage?.inputTokens ?? 0), 0);

/**
 * An AI SDK `stopWhen` condition: true once the run's cumulative input tokens meet `cap`.
 *
 * Sits in the same `stopWhen` array as `stepCountIs`, so a budget stage stops the loop the same way
 * running out of steps does.
 */
export const tokenBudgetExceeded =
    (cap: number) =>
    ({ steps }: { steps: readonly { usage?: { inputTokens?: number } }[] }): boolean =>
        sumInputTokens(steps) >= cap;

/**
 * A failure string naming both the cap and what was actually spent, or `undefined` when `used` is
 * still under `cap`.
 *
 * "Budget exceeded" tells an operator nothing about whether to raise the cap or shrink the card;
 * this names the figures so they don't have to go dig for them.
 */
export const overBudget = (used: number | undefined, cap: number): string | undefined => {
    if (used === undefined || used < cap) return undefined;
    return `input token budget exceeded: used ${used}, cap ${cap}`;
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
