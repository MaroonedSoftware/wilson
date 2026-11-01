// Card 0274: `lastEventAge`, `LAST_EVENT_STALE_MS` and `showsLastEventLine` (`apps/web/src/lib/board.ts`)
// are new — the pure logic behind a board tile's "last event" line (AC2-AC5). None of the three
// exist on the pre-change tree, so this whole file fails to even import there. A dedicated file
// (mirroring `board.test.ts`'s own `ageInStage` describe block one level up) rather than appended
// into `board.test.ts` itself, so this card's new exports don't drag the file's pre-existing,
// already-passing coverage into the same import failure on the pre-change tree.
import { describe, expect, it } from 'vitest';
import { LAST_EVENT_STALE_MS, lastEventAge, showsLastEventLine } from '#src/lib/board.js';

describe('lastEventAge', () => {
    const now = new Date('2026-01-10T12:00:00.000Z');

    it('renders seconds for under a minute (AC3: the board tile updates on a ten-second beat)', () => {
        expect(lastEventAge('2026-01-10T11:59:30.000Z', now)).toBe('30s ago');
    });

    it('renders minutes for under an hour', () => {
        expect(lastEventAge('2026-01-10T11:45:00.000Z', now)).toBe('15m ago');
    });

    it('renders hours for under a day', () => {
        expect(lastEventAge('2026-01-10T06:00:00.000Z', now)).toBe('6h ago');
    });

    it('renders days at a day or more', () => {
        expect(lastEventAge('2026-01-07T12:00:00.000Z', now)).toBe('3d ago');
    });

    it('clamps a ts newer than now to "0s ago" instead of a negative duration', () => {
        expect(lastEventAge('2026-01-10T12:00:05.000Z', now)).toBe('0s ago');
    });
});

describe('LAST_EVENT_STALE_MS', () => {
    it("is five minutes, matching card 0204's proposed idle watchdog", () => {
        expect(LAST_EVENT_STALE_MS).toBe(5 * 60 * 1000);
    });
});

describe('showsLastEventLine', () => {
    it('is false when no activity has arrived yet for the card', () => {
        expect(showsLastEventLine(undefined, 'testing')).toBe(false);
    });

    it("is true for a stage.dispatched event whose own stage matches the card's current stage", () => {
        expect(showsLastEventLine({ type: 'stage.dispatched', stage: 'testing', payload: null, ts: '2026-01-10T12:00:00.000Z' }, 'testing')).toBe(
            true,
        );
    });

    it.each(['tool.executed', 'tool.denied', 'tool.unguarded'])("is true for a %s event whose own stage matches the card's current stage", type => {
        expect(showsLastEventLine({ type, stage: 'testing', payload: null, ts: '2026-01-10T12:00:00.000Z' }, 'testing')).toBe(true);
    });

    it("is false when the event's own stage differs from the card's current stage (AC5: the card has since moved on)", () => {
        expect(showsLastEventLine({ type: 'tool.executed', stage: 'planning', payload: null, ts: '2026-01-10T12:00:00.000Z' }, 'testing')).toBe(
            false,
        );
    });

    it('is false for an event type that is neither stage.dispatched nor tool.*', () => {
        expect(showsLastEventLine({ type: 'stage.completed', stage: 'testing', payload: null, ts: '2026-01-10T12:00:00.000Z' }, 'testing')).toBe(
            false,
        );
    });
});
