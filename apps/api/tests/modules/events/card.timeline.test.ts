import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { foldCardTimeline } from '#modules/events/card.timeline.js';
import type { CardEventRow } from '#modules/events/event.log.js';

const T0 = DateTime.utc(2026, 11, 7, 9, 0);
let id = 0;
const at = (minute: number, stage: string, type: string, payload: Record<string, unknown> = {}): CardEventRow => ({
    id: String(++id),
    stage,
    type: type as CardEventRow['type'],
    payload,
    createdAt: T0.plus({ minutes: minute }),
});
const min = (n: number) => n * 60_000;

describe('foldCardTimeline', () => {
    it('splits a card’s life into queued, running and waiting on a person, adding up to the wall clock', () => {
        const figures = foldCardTimeline(
            [
                at(0, 'backlog', 'transition.written', { from: 'planning', to: 'backlog', by: 'operator' }),
                at(5, 'backlog', 'transition.written', { from: 'backlog', to: 'implementing', by: 'runner' }),
                at(7, 'implementing', 'worktree.created', { baseSha: 'b1' }),
                at(7, 'implementing', 'stage.dispatched'),
                at(27, 'implementing', 'stage.passed'),
                at(27, 'implementing', 'transition.written', { from: 'implementing', to: 'review', by: 'runner' }),
                at(28, 'review', 'stage.dispatched'),
                at(38, 'review', 'stage.passed', { result: { verdict: 'pass' } }),
                at(38, 'review', 'transition.written', { from: 'review', to: 'ready', by: 'runner' }),
                at(98, 'ready', 'transition.written', { from: 'ready', to: 'done', by: 'operator' }),
            ],
            T0.plus({ days: 1 }),
        );

        expect(figures.ended).toBe(true);
        expect(figures.totals).toEqual({ queuedMs: min(8), runningMs: min(30), waitingOnPersonMs: min(60), wallClockMs: min(98) });
        expect(figures.reviewRounds).toBe(1);
        expect(figures.spans.map(span => [span.kind, span.stage, span.durationMs / 60_000, span.outcome])).toEqual([
            ['queued', 'backlog', 5, undefined],
            ['queued', 'implementing', 2, undefined],
            ['running', 'implementing', 20, 'passed'],
            ['queued', 'review', 1, undefined],
            ['running', 'review', 10, 'passed'],
            ['waitingOnPerson', 'ready', 60, undefined],
        ]);
    });

    it('counts a flagged stretch as waiting on a person until the flag is answered', () => {
        const figures = foldCardTimeline(
            [
                at(0, 'implementing', 'stage.dispatched'),
                at(10, 'implementing', 'stage.blocked'),
                at(10, 'implementing', 'transition.written', { from: 'implementing', to: 'implementing', by: 'runner', needsHuman: true }),
                at(40, 'implementing', 'card.answered'),
                at(42, 'implementing', 'stage.dispatched'),
            ],
            T0.plus({ minutes: 50 }),
        );

        expect(figures.ended).toBe(false);
        expect(figures.totals).toMatchObject({ runningMs: min(18), waitingOnPersonMs: min(30), queuedMs: min(2), wallClockMs: min(50) });
    });

    it('counts a kickback and a rerun on code nobody changed since the last judgment', () => {
        const figures = foldCardTimeline(
            [
                at(0, 'testing', 'worktree.created', { baseSha: 'b1' }),
                at(0, 'testing', 'stage.dispatched'),
                at(5, 'testing', 'stage.failed', { failureClass: 'verifier' }),
                at(5, 'testing', 'transition.written', { from: 'testing', to: 'testing', by: 'runner', failureClass: 'verifier' }),
                at(6, 'testing', 'worktree.created', { baseSha: 'b1' }),
                at(6, 'testing', 'stage.dispatched'),
                at(9, 'testing', 'stage.passed'),
                at(9, 'testing', 'work.committed', { sha: 'c1' }),
                at(9, 'testing', 'transition.written', { from: 'testing', to: 'review', by: 'runner' }),
                at(10, 'review', 'worktree.created', { baseSha: 'b1' }),
                at(10, 'review', 'stage.dispatched'),
                at(12, 'review', 'stage.passed', { result: { verdict: 'revise' } }),
                at(12, 'review', 'transition.written', { from: 'review', to: 'implementing', by: 'runner', failureClass: 'revise' }),
            ],
            T0.plus({ minutes: 20 }),
        );

        expect(figures.repeatedRuns).toEqual([{ stage: 'testing', count: 1 }]);
        expect(figures.kickbacks).toBe(1);
    });

    it('does not count a rerun once a commit or a new base changed the code', () => {
        const figures = foldCardTimeline(
            [
                at(0, 'review', 'worktree.created', { baseSha: 'b1' }),
                at(0, 'review', 'stage.dispatched'),
                at(1, 'review', 'stage.passed'),
                at(2, 'implementing', 'work.committed', { sha: 'c2' }),
                at(3, 'review', 'worktree.created', { baseSha: 'b1' }),
                at(3, 'review', 'stage.dispatched'),
                at(4, 'review', 'stage.passed'),
                at(5, 'review', 'worktree.created', { baseSha: 'b2' }),
                at(5, 'review', 'stage.dispatched'),
            ],
            T0.plus({ minutes: 6 }),
        );

        expect(figures.repeatedRuns).toEqual([]);
    });

    it('is empty for a card with no events', () => {
        expect(foldCardTimeline([], T0)).toMatchObject({ spans: [], totals: { wallClockMs: 0 }, ended: false });
    });
});
