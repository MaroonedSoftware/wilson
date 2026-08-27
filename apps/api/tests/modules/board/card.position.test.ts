import { describe, expect, it } from 'vitest';
import { POSITION_GAP, rankBetween, renormalizedPositions } from '#modules/board/card.position.js';

/**
 * Card 0091. `rankBetween`/`renormalizedPositions` are pure — no repository, no database — precisely
 * so the "gap exhausted" case is reachable and testable without standing up a board. These tests
 * exercise that contract directly.
 */
describe('rankBetween', () => {
    it('gives an empty column a position a full gap above zero, not zero itself', () => {
        expect(rankBetween(undefined, undefined)).toEqual({ ok: true, position: POSITION_GAP });
    });

    it('drops a new bottom card a full gap below the current last position when there is no `after`', () => {
        expect(rankBetween(1000, undefined)).toEqual({ ok: true, position: 1000 + POSITION_GAP });
    });

    it('drops a new top card a full gap above the current first position when there is no `before`', () => {
        expect(rankBetween(undefined, 1000)).toEqual({ ok: true, position: 1000 - POSITION_GAP });
    });

    it('ranks a card at the integer midpoint of two neighbours with room between them', () => {
        expect(rankBetween(1000, 2000)).toEqual({ ok: true, position: 1500 });
    });

    it('ranks correctly even when the midpoint is not evenly divisible, flooring toward `before`', () => {
        // Midpoint of 1000 and 1003 is 1001.5, floored to 1001 — strictly between the two, so this
        // must still succeed rather than being treated as exhausted.
        expect(rankBetween(1000, 1003)).toEqual({ ok: true, position: 1001 });
    });

    it('reports the gap exhausted when the neighbours are adjacent integers, with nothing between them', () => {
        expect(rankBetween(1000, 1001)).toEqual({ ok: false });
    });

    it('reports the gap exhausted when the neighbours are equal — never invents an integer at all', () => {
        expect(rankBetween(1000, 1000)).toEqual({ ok: false });
    });

    it('reports the gap exhausted rather than returning a position outside [before, after] on an inverted pair', () => {
        // A caller could in principle hand these in swapped; the midpoint of an inverted pair falls
        // outside the (before, after) interval, which the "must be strictly between" check catches.
        expect(rankBetween(2000, 1000)).toEqual({ ok: false });
    });
});

describe('renormalizedPositions', () => {
    it('spaces every id one POSITION_GAP apart, in the order given, one-indexed so the top has headroom above it', () => {
        const spaced = renormalizedPositions(['0001', '0002', '0003']);

        expect(spaced.get('0001')).toBe(POSITION_GAP);
        expect(spaced.get('0002')).toBe(POSITION_GAP * 2);
        expect(spaced.get('0003')).toBe(POSITION_GAP * 3);
    });

    it('produces positions rankBetween can always find room between, for any adjacent pair', () => {
        const order = ['0001', '0002', '0003', '0004'];
        const spaced = renormalizedPositions(order);

        for (let i = 0; i < order.length - 1; i++) {
            const before = spaced.get(order[i])!;
            const after = spaced.get(order[i + 1])!;
            expect(rankBetween(before, after)).toEqual({ ok: true, position: (before + after) / 2 });
        }
    });

    it('returns an empty map for an empty column', () => {
        expect(renormalizedPositions([])).toEqual(new Map());
    });

    it('preserves the order it was given, not sorting the ids itself', () => {
        const spaced = renormalizedPositions(['0099', '0002', '0050']);

        expect(spaced.get('0099')).toBeLessThan(spaced.get('0002')!);
        expect(spaced.get('0002')).toBeLessThan(spaced.get('0050')!);
    });
});
