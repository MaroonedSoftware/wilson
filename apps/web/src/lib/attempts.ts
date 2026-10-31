import type { CardEvent } from '@wilson/sdk';

/** The events that end an attempt, and what each one means for it. */
const ENDINGS: Record<string, AttemptOutcome> = {
    'stage.passed': 'passed',
    'stage.failed': 'failed',
    'stage.poisoned': 'poisoned',
    'stage.dead': 'dead',
};

/**
 * `running` is the latest attempt with no ending yet. `interrupted` is one a later attempt replaced
 * with no ending at all, as a daemon restart leaves behind.
 */
export type AttemptOutcome = 'running' | 'interrupted' | 'passed' | 'failed' | 'poisoned' | 'dead';

/** One run of a stage, as the card's events record it. */
export interface CardAttempt {
    id: string;
    stage: string;
    outcome: AttemptOutcome;
    startedAt: CardEvent['createdAt'];
    /** Everything the run was sent, cached tokens included. */
    inputTokens?: number;
    outputTokens?: number;
    toolCalls: number;
    denials: number;
    /** Every read the run made. Absent for an attempt recorded before traces existed. */
    reads?: number;
    readPaths: string[];
    finalMessage?: string;
    failures: string[];
}

const payloadOf = (event: CardEvent): Record<string, unknown> =>
    typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload) ? (event.payload as Record<string, unknown>) : {};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

const number = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

const withEnding = (attempt: CardAttempt, event: CardEvent, outcome: AttemptOutcome): CardAttempt => {
    const payload = payloadOf(event);
    const usage = (payload.usage ?? {}) as Record<string, unknown>;
    const trace = (payload.trace ?? {}) as Record<string, unknown>;
    return {
        ...attempt,
        outcome,
        ...(number(usage.inputTokens) !== undefined && { inputTokens: (number(usage.inputTokens) ?? 0) + (number(usage.cachedInputTokens) ?? 0) }),
        ...(number(usage.outputTokens) !== undefined && { outputTokens: number(usage.outputTokens) }),
        reads: number(trace.reads),
        readPaths: strings(trace.readPaths),
        ...(typeof trace.finalMessage === 'string' ? { finalMessage: trace.finalMessage } : {}),
        failures: strings(payload.failures),
    };
};

/**
 * A card's attempts, newest first, from its events oldest first. Events from before the first
 * `stage.dispatched` in the list are dropped, since the list can be a tail of a longer history.
 */
export const groupAttempts = (events: readonly CardEvent[]): CardAttempt[] => {
    const attempts: CardAttempt[] = [];
    for (const event of events) {
        const latest = attempts.at(-1);
        if (event.type === 'stage.dispatched') {
            if (latest?.outcome === 'running') latest.outcome = 'interrupted';
            attempts.push({
                id: event.id,
                stage: event.stage ?? 'unknown',
                outcome: 'running',
                startedAt: event.createdAt,
                toolCalls: 0,
                denials: 0,
                readPaths: [],
                failures: [],
            });
            continue;
        }
        if (latest?.outcome !== 'running') continue;
        if (event.type === 'tool.executed') latest.toolCalls += 1;
        if (event.type === 'tool.denied') latest.denials += 1;
        const outcome = ENDINGS[event.type];
        if (outcome) attempts[attempts.length - 1] = withEnding(latest, event, outcome);
    }
    return attempts.reverse();
};
