import { DateTime, Duration } from 'luxon';
import { describe, expect, it } from 'vitest';
import { stageEnteredAt, timeInCurrentStage } from '#modules/events/time.in.stage.js';
import type { CardEventRow } from '#modules/events/event.log.js';

const event = (type: CardEventRow['type'], createdAt: string): CardEventRow => ({
    id: createdAt,
    stage: null,
    type,
    payload: {},
    createdAt: DateTime.fromISO(createdAt, { zone: 'utc' }),
});

describe('stageEnteredAt', () => {
    it('returns undefined when there are no events', () => {
        expect(stageEnteredAt([])).toBeUndefined();
    });

    it('answers with the earliest event when the card has never transitioned', () => {
        const events = [event('stage.dispatched', '2024-01-01T00:00:00.000Z'), event('scope.requested', '2024-01-01T01:00:00.000Z')];

        expect(stageEnteredAt(events)?.toISO()).toBe(events[0]!.createdAt.toISO());
    });

    it('answers with the most recent transition.written event, ignoring later non-transition events', () => {
        const events = [
            event('stage.dispatched', '2024-01-01T00:00:00.000Z'),
            event('transition.written', '2024-01-02T00:00:00.000Z'),
            event('stage.dispatched', '2024-01-02T06:00:00.000Z'),
        ];

        expect(stageEnteredAt(events)?.toISO()).toBe(events[1]!.createdAt.toISO());
    });
});

describe('timeInCurrentStage', () => {
    it('returns undefined when there are no events', () => {
        expect(timeInCurrentStage([], DateTime.utc())).toBeUndefined();
    });

    it('measures from the earliest event when the card has never transitioned', () => {
        const events = [event('stage.dispatched', '2024-01-01T00:00:00.000Z'), event('scope.requested', '2024-01-01T01:00:00.000Z')];
        const now = DateTime.fromISO('2024-01-01T03:00:00.000Z', { zone: 'utc' });

        const result = timeInCurrentStage(events, now);

        expect(result).toBeInstanceOf(Duration);
        expect(result?.as('hours')).toBe(3);
    });

    it('measures from the most recent transition.written event, ignoring later non-transition events', () => {
        const events = [
            event('stage.dispatched', '2024-01-01T00:00:00.000Z'),
            event('transition.written', '2024-01-02T00:00:00.000Z'),
            event('stage.dispatched', '2024-01-02T06:00:00.000Z'),
        ];
        const now = DateTime.fromISO('2024-01-02T12:00:00.000Z', { zone: 'utc' });

        const result = timeInCurrentStage(events, now);

        // Since the last transition, not since the earliest event.
        expect(result?.as('hours')).toBe(12);
    });

    it('uses the most recent transition.written event when several are present', () => {
        const events = [
            event('transition.written', '2024-01-01T00:00:00.000Z'),
            event('stage.dispatched', '2024-01-01T01:00:00.000Z'),
            event('transition.written', '2024-01-01T10:00:00.000Z'),
        ];
        const now = DateTime.fromISO('2024-01-01T12:00:00.000Z', { zone: 'utc' });

        const result = timeInCurrentStage(events, now);

        expect(result?.as('hours')).toBe(2);
    });

    it('is pure: it never reads the clock itself, only what is passed in as now', () => {
        const events = [event('transition.written', '2024-01-01T00:00:00.000Z')];

        const soon = timeInCurrentStage(events, DateTime.fromISO('2024-01-01T00:00:01.000Z', { zone: 'utc' }));
        const later = timeInCurrentStage(events, DateTime.fromISO('2024-01-02T00:00:01.000Z', { zone: 'utc' }));

        expect(soon?.as('seconds')).toBeCloseTo(1, 2);
        expect(later?.as('days')).toBeCloseTo(1, 4);
    });
});
