import type { JsonValue } from '@wilson/sdk';

/** How an activity row reads: a sentence, and the colour of its dot. */
export interface ActivitySummary {
    label: string;
    color: string;
}

/** `type`'s wording and colour. `{stage}` is filled in from the event's own stage. */
const SUMMARIES: Record<string, ActivitySummary> = {
    'stage.dispatched': { label: 'Started {stage}', color: 'blue' },
    'stage.placed': { label: 'Placed {stage} on a host', color: 'blue' },
    'stage.host-lost': { label: 'Lost the host running {stage}', color: 'orange' },
    'stage.passed': { label: 'Passed {stage}', color: 'green' },
    'stage.failed': { label: 'Failed {stage}', color: 'red' },
    'stage.poisoned': { label: 'Poisoned in {stage}', color: 'red' },
    'stage.dead': { label: 'Gave up on {stage}', color: 'red' },
    'stage.stale': { label: 'Abandoned a stale {stage} run', color: 'orange' },
    'test.flaky': { label: 'Found a flaky test', color: 'orange' },
    'rebase.conflict': { label: 'Hit a rebase conflict', color: 'red' },
    'context.overflow': { label: 'Ran out of context in {stage}', color: 'red' },
    'dispatch.deferred': { label: 'Deferred dispatch', color: 'gray' },
    'engine.failed': { label: 'Engine failed in {stage}', color: 'red' },
    'turn.empty': { label: 'Engine ended its turn without working', color: 'orange' },
    'scope.requested': { label: 'Requested more scope', color: 'blue' },
    'scope.granted': { label: 'Scope granted', color: 'green' },
    'scope.refused': { label: 'Scope refused', color: 'orange' },
    'work.committed': { label: 'Committed work', color: 'green' },
    'transition.failed': { label: 'Could not move the card', color: 'red' },
    'chain.stopped': { label: 'Stopped after {stage}', color: 'gray' },
    'card.flagged': { label: 'Flagged for a human', color: 'red' },
    'card.acked': { label: 'Flag acknowledged', color: 'green' },
    'card.over-budget': { label: 'Went over budget', color: 'red' },
    'card.auto-split': { label: 'Split automatically', color: 'blue' },
    'card.plan-drafted': { label: 'Drafted a plan', color: 'green' },
    'job.orphaned': { label: 'Recovered an orphaned job', color: 'orange' },
};

const record = (payload: JsonValue): Record<string, JsonValue> =>
    typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, JsonValue>) : {};

/**
 * One event as a sentence. A type with no wording of its own shows as recorded, so an event type
 * added later still appears rather than vanishing from the feed.
 */
export const summarizeActivity = (type: string, stage: string | null, payload: JsonValue): ActivitySummary => {
    if (type === 'transition.written') {
        const { from, to } = record(payload);
        if (typeof to === 'string' && to !== from) return { label: `Moved to ${to}`, color: 'blue' };
        return { label: 'Updated the card', color: 'gray' };
    }
    const summary = SUMMARIES[type];
    if (!summary) return { label: type, color: 'gray' };
    return { ...summary, label: summary.label.replace('{stage}', stage ?? 'a stage') };
};

/** Why it happened, when the event recorded a reason. */
export const activityReason = (payload: JsonValue): string | undefined => {
    const { reason } = record(payload);
    return typeof reason === 'string' && reason ? reason : undefined;
};
