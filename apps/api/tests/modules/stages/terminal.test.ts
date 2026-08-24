import { describe, expect, it } from 'vitest';
import { isTerminal } from '#modules/stages/terminal.js';

describe('isTerminal', () => {
    it('is true for every state that ends a card’s life', () => {
        expect(isTerminal('merged')).toBe(true);
        expect(isTerminal('dropped')).toBe(true);
        expect(isTerminal('poisoned')).toBe(true);
        expect(isTerminal('needs-human')).toBe(true);
    });

    it('is false for ordinary stages a card is still moving through', () => {
        expect(isTerminal('implementing')).toBe(false);
        expect(isTerminal('testing')).toBe(false);
        expect(isTerminal('review')).toBe(false);
    });

    // `parking-lot` is a `NON_STAGE_STATES` entry in stage.config.ts, same family as `merged` and
    // `needs-human`, but a parked card is waiting to be promoted rather than finished. If `isTerminal`
    // were ever reimplemented as a reuse of `NON_STAGE_STATES` this would start returning true and
    // silently start reclaiming worktrees out from under parked cards.
    it('is false for parking-lot even though it is also a non-stage state', () => {
        expect(isTerminal('parking-lot')).toBe(false);
    });

    it('is false for an unrecognized string', () => {
        expect(isTerminal('some-made-up-stage')).toBe(false);
    });
});
