/**
 * Card 0252. On 2026-09-19, against host engine 2.1.278 (the host binary upgraded itself from
 * 2.1.266 during the day), two of `cli.engine.contract.probe.ts`'s six probes failed with messages
 * that could not tell a changed engine from a model that simply behaved differently:
 *
 * - "still reports cleanly at a tight step budget when the one bash call is denied" failed its
 *   guard-consulted check. Instrumented by hand, the adapter's run recorded no events at all — no
 *   `tool.denied`, no `tool.executed`, no `tool.unguarded` — and ended `truncated` with "step budget
 *   exceeded: 2 steps". Nothing in that failure said whether the model spent its two steps on
 *   something that leaves no event at all (a read), or on nothing.
 * - "is never consulted at all, and the write actually lands, once allowedTools bypasses it" failed
 *   because the write never landed. Nothing said whether that was the engine no longer bypassing the
 *   guard for `allowedTools`, or the model never attempting the write in the first place.
 *
 * `describeProbeRun` turns whatever a probe recorded into one string: every tool call the model is
 * known to have attempted, in the order it attempted them; the event types the adapter itself
 * recorded, in order; and, when the caller has them, `truncated`, `budgetFailure` and
 * `engineStopReason` — the same fields `CliStageAgent.run`'s own return value already carries. This
 * module never talks to an engine or reads model prose itself — the Constraints call that a flake
 * generator — it only formats what the caller already recorded, so a probe's failure can say what the
 * model actually did instead of leaving that to be reconstructed by hand.
 */

/** One tool call the model is known to have attempted, in whatever form the caller could observe it. */
export interface AttemptedToolCall {
    /** The tool's name, or a description of the mechanism used to see it (e.g. `report_result`). */
    tool: string;
    /** The command (Bash) or path (everything else) the call carried. */
    detail: string;
}

/** One event the adapter itself recorded — `context.events`'s own shape, narrowed to what matters here. */
export interface RecordedEvent {
    type: string;
}

/** The fields of `CliStageAgent.run`'s return value this card's two failing probes assert on. */
export interface ProbeRunOutput {
    truncated?: boolean;
    budgetFailure?: string;
    engineStopReason?: string;
}

export interface ProbeRun {
    /** Every tool call the model is known to have attempted, in the order it attempted them. */
    attempted: AttemptedToolCall[];
    /** Every event type the adapter recorded, in order. */
    events: RecordedEvent[];
    /** `CliStageAgent.run`'s output, when this probe went through it. Omitted for a raw `query()` probe. */
    output?: ProbeRunOutput;
}

/**
 * One string describing what a probe run actually did: the attempted tool calls, in order; the
 * recorded event types, in order; and whichever of `truncated`/`budgetFailure`/`engineStopReason`
 * `output` carries. Meant to be passed as the message of every `expect` in a probe whose failure
 * needs to say what the model did, not just that the assertion did not hold.
 */
export const describeProbeRun = ({ attempted, events, output }: ProbeRun): string => {
    const parts: string[] = [
        attempted.length
            ? `tool calls attempted, in order: ${attempted.map(call => `${call.tool}(${call.detail})`).join(', ')}`
            : 'no tool call was attempted',
        events.length ? `events recorded, in order: ${events.map(event => event.type).join(', ')}` : 'no events were recorded',
    ];

    if (output) {
        const outcome: string[] = [];
        if (output.truncated !== undefined) outcome.push(`truncated: ${output.truncated}`);
        if (output.budgetFailure !== undefined) outcome.push(`budgetFailure: ${output.budgetFailure}`);
        if (output.engineStopReason !== undefined) outcome.push(`engineStopReason: ${output.engineStopReason}`);
        if (outcome.length) parts.push(outcome.join(', '));
    }

    return parts.join(' | ');
};
