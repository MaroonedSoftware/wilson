import type { DateTime } from 'luxon';
import type { CardEventRow } from './event.log.js';

/** Lanes where a card waits on a person rather than on the queue: nothing dispatches them. */
const PERSON_LANES = new Set(['planning', 'ready', 'parking-lot']);

/** Where a card's time went, one stretch at a time. */
export type TimelineKind = 'queued' | 'running' | 'waitingOnPerson';

export interface TimelineSpan {
    kind: TimelineKind;
    /** The lane the card was in. */
    stage: string;
    /** The step of `stage` that ran, for a running span of one. */
    step?: string;
    startedAt: DateTime;
    endedAt: DateTime;
    durationMs: number;
    /** How a running span ended: the event that closed it. */
    outcome?: 'passed' | 'failed' | 'blocked' | 'interrupted';
}

/** A stage that ran again on the same code it had already judged, and how many times. */
export interface RepeatedRun {
    stage: string;
    step?: string;
    count: number;
}

export interface CardTimelineFigures {
    spans: TimelineSpan[];
    totals: { queuedMs: number; runningMs: number; waitingOnPersonMs: number; wallClockMs: number };
    /** Runs of a lane's own review that judged the work. */
    reviewRounds: number;
    /** Transitions the runner wrote that sent the card back. */
    kickbacks: number;
    repeatedRuns: RepeatedRun[];
    /** Whether the card has reached `done`, so `now` no longer stretches the last span. */
    ended: boolean;
}

const END_OF_RUN: Partial<Record<string, NonNullable<TimelineSpan['outcome']>>> = {
    'stage.passed': 'passed',
    'stage.failed': 'failed',
    'stage.blocked': 'blocked',
    'stage.interrupted': 'interrupted',
};

const text = (payload: Record<string, unknown>, key: string): string | undefined =>
    typeof payload[key] === 'string' ? (payload[key] as string) : undefined;

/** Whether a card in `stage` with or without a flag is waiting on a person or on the queue. */
const waitingKind = (stage: string, flagged: boolean): TimelineKind => (flagged || PERSON_LANES.has(stage) ? 'waitingOnPerson' : 'queued');

/**
 * Fold one card's events, oldest first, into where its time went: queued for the runner, running a
 * stage, or waiting on a person (a flag, a question, or a lane a person moves). Every moment between
 * the first event and `now` (or the card reaching `done`) lands in exactly one span, so the totals add
 * up to the wall clock.
 *
 * Also counts the runs that judged code already judged: a stage dispatched again with no commit since
 * its last finished run and the same base. Each is a run whose result could have been reused, so their
 * count bounds what caching a stage's result by its tree would save.
 */
export const foldCardTimeline = (events: readonly CardEventRow[], now: DateTime): CardTimelineFigures => {
    const spans: TimelineSpan[] = [];
    const repeated = new Map<string, RepeatedRun>();
    let reviewRounds = 0;
    let kickbacks = 0;
    let ended = false;

    const first = events[0];
    if (!first) {
        return {
            spans,
            totals: { queuedMs: 0, runningMs: 0, waitingOnPersonMs: 0, wallClockMs: 0 },
            reviewRounds,
            kickbacks,
            repeatedRuns: [],
            ended,
        };
    }

    let lane = first.stage ?? '';
    let flagged = false;
    let current: { kind: TimelineKind; stage: string; step?: string; since: DateTime } = {
        kind: waitingKind(lane, false),
        stage: lane,
        since: first.createdAt,
    };

    /** Close the open stretch at `at` and start the next one there. */
    const move = (at: DateTime, next: { kind: TimelineKind; stage: string; step?: string }, outcome?: TimelineSpan['outcome']): void => {
        const durationMs = Math.max(0, at.toMillis() - current.since.toMillis());
        const last = spans[spans.length - 1];
        const same = last && !outcome && !last.outcome && last.kind === current.kind && last.stage === current.stage && last.step === current.step;
        if (same) {
            last.endedAt = at;
            last.durationMs += durationMs;
        } else if (durationMs > 0 || outcome) {
            spans.push({
                kind: current.kind,
                stage: current.stage,
                ...(current.step ? { step: current.step } : {}),
                startedAt: current.since,
                endedAt: at,
                durationMs,
                ...(outcome ? { outcome } : {}),
            });
        }
        current = { ...next, since: at };
    };

    /** Per stage and step: whether code changed since its last finished run, and the base it ran on. */
    const judged = new Map<string, { changed: boolean; base?: string }>();
    let pendingBase: string | undefined;

    for (const event of events) {
        const at = event.createdAt;
        const step = text(event.payload, 'step');
        const key = `${event.stage ?? ''}\0${step ?? ''}`;

        switch (event.type) {
            case 'worktree.created':
                pendingBase = text(event.payload, 'baseSha');
                break;
            case 'work.committed':
                for (const entry of judged.values()) entry.changed = true;
                break;
            case 'stage.dispatched': {
                const before = judged.get(key);
                if (before && !before.changed && before.base !== undefined && before.base === pendingBase) {
                    const row = repeated.get(key) ?? { stage: event.stage ?? '', ...(step ? { step } : {}), count: 0 };
                    row.count += 1;
                    repeated.set(key, row);
                }
                judged.set(key, { changed: false, ...(pendingBase !== undefined ? { base: pendingBase } : {}) });
                move(at, { kind: 'running', stage: event.stage ?? lane, ...(step ? { step } : {}) });
                break;
            }
            case 'transition.written': {
                const to = text(event.payload, 'to') ?? lane;
                const byRunner = text(event.payload, 'by') === 'runner';
                if (byRunner && text(event.payload, 'failureClass') && to !== text(event.payload, 'from')) kickbacks += 1;
                lane = to;
                flagged = event.payload.needsHuman === true ? true : byRunner ? flagged : false;
                if (lane === 'done') {
                    move(at, { kind: 'waitingOnPerson', stage: lane });
                    ended = true;
                } else if (current.kind !== 'running') {
                    move(at, { kind: waitingKind(lane, flagged), stage: lane });
                }
                break;
            }
            case 'card.acked':
            case 'card.answered':
                flagged = false;
                if (current.kind !== 'running') move(at, { kind: waitingKind(lane, false), stage: lane });
                break;
            default: {
                const outcome = END_OF_RUN[event.type];
                if (!outcome) break;
                if (outcome === 'passed' && !step && event.stage === 'review') reviewRounds += 1;
                // A run that ended without a judgment is not one whose result a rerun repeats.
                if (outcome === 'interrupted' || outcome === 'blocked') judged.delete(key);
                if (current.kind === 'running') move(at, { kind: waitingKind(lane, flagged), stage: lane }, outcome);
            }
        }
        if (ended) break;
    }

    if (!ended) move(now, current);

    const sum = (kind: TimelineKind) => spans.filter(span => span.kind === kind).reduce((total, span) => total + span.durationMs, 0);
    const last = spans[spans.length - 1];
    return {
        spans,
        totals: {
            queuedMs: sum('queued'),
            runningMs: sum('running'),
            waitingOnPersonMs: sum('waitingOnPerson'),
            wallClockMs: last ? last.endedAt.toMillis() - first.createdAt.toMillis() : 0,
        },
        reviewRounds,
        kickbacks,
        repeatedRuns: [...repeated.values()],
        ended,
    };
};
