import { describe, expect, it } from 'vitest';
import { nextCard, unsatisfiedDependencies } from '#modules/board/next.card.js';
import type { Card, CardFrontmatter } from '#modules/board/card.js';

const card = (id: string, stage: string, dependsOn: string[] = []): Card => ({
    frontmatter: {
        id,
        title: `Card ${id}`,
        stage,
        dependsOn,
        retries: {},
    } as CardFrontmatter,
    sections: {},
    body: '',
});

describe('nextCard', () => {
    it('returns no candidate and no blocked cards for an empty board', () => {
        expect(nextCard([])).toEqual({ next: undefined, blocked: [] });
    });

    it('picks the eligible card with the lowest id, compared as a zero-padded string', () => {
        const cards = [card('0010', 'planning'), card('0002', 'implementing'), card('0100', 'testing')];

        const { next } = nextCard(cards);

        expect(next?.frontmatter.id).toBe('0002');
    });

    it('ignores cards in every non-stage state, even when they would otherwise be the lowest id', () => {
        const cards = [
            card('0001', 'merged'),
            card('0002', 'parking-lot'),
            card('0003', 'needs-human'),
            card('0004', 'poisoned'),
            card('0005', 'dropped'),
            card('0006', 'implementing'),
        ];

        const { next, blocked } = nextCard(cards);

        expect(next?.frontmatter.id).toBe('0006');
        expect(blocked).toEqual([]);
    });

    it('treats a dependency on a merged card as satisfied', () => {
        const cards = [card('0001', 'merged'), card('0002', 'implementing', ['0001'])];

        const { next, blocked } = nextCard(cards);

        expect(next?.frontmatter.id).toBe('0002');
        expect(blocked).toEqual([]);
    });

    it('blocks a card whose dependency exists but has not merged yet', () => {
        const cards = [card('0001', 'implementing'), card('0002', 'planning', ['0001'])];

        const { next, blocked } = nextCard(cards);

        // 0001 has no dependencies of its own, so it is the eligible candidate; 0002 waits on it.
        expect(next?.frontmatter.id).toBe('0001');
        expect(blocked).toHaveLength(1);
        expect(blocked[0]?.card.frontmatter.id).toBe('0002');
        expect(blocked[0]?.blockedBy).toEqual(['0001']);
    });

    it('treats a dependency on a card that does not exist on the board as blocking, not as fine', () => {
        const dangling = card('0002', 'planning', ['9999']);

        const { next, blocked } = nextCard([dangling]);

        expect(next).toBeUndefined();
        expect(blocked).toEqual([{ card: dangling, blockedBy: ['9999'] }]);
    });

    it('lists offending dependency ids in the order they appear in dependsOn', () => {
        const cards = [card('0001', 'implementing'), card('0002', 'planning'), card('0003', 'testing', ['0002', '0001'])];

        const { blocked } = nextCard(cards);

        expect(blocked[0]?.blockedBy).toEqual(['0002', '0001']);
    });

    it('reports only the dependencies that are unsatisfied when a card has a mix', () => {
        const cards = [card('0001', 'merged'), card('0002', 'implementing'), card('0003', 'planning', ['0001', '0002'])];

        const { blocked } = nextCard(cards);

        expect(blocked[0]?.blockedBy).toEqual(['0002']);
    });

    it('sorts blocked cards by id, lowest first, independent of input order', () => {
        const cards = [card('0005', 'planning', ['9999']), card('0001', 'planning', ['9999']), card('0003', 'planning', ['9999'])];

        const { blocked } = nextCard(cards);

        expect(blocked.map(b => b.card.frontmatter.id)).toEqual(['0001', '0003', '0005']);
    });

    it('never proposes a blocked card as next, even when its id is lower than every candidate', () => {
        const cards = [card('0001', 'planning', ['9999']), card('0050', 'implementing')];

        const { next, blocked } = nextCard(cards);

        expect(next?.frontmatter.id).toBe('0050');
        expect(blocked.map(b => b.card.frontmatter.id)).toEqual(['0001']);
    });

    it('reports no candidate and no blocked cards when the whole board is finished or parked', () => {
        const cards = [card('0001', 'merged'), card('0002', 'parking-lot')];

        expect(nextCard(cards)).toEqual({ next: undefined, blocked: [] });
    });
});

/**
 * Card 0023: `unsatisfiedDependencies` is now exported so `card list` and `StageDispatcher` can ask
 * the same question `nextCard` does instead of re-deriving their own. Exercised directly here,
 * independent of `nextCard`'s candidate/sort logic, so a caller that only wants "which ids are
 * outstanding" is covered on its own terms.
 */
describe('unsatisfiedDependencies', () => {
    it('returns an empty list for a card with no dependencies', () => {
        const cards = [card('0001', 'planning')];

        expect(unsatisfiedDependencies(cards[0]!, cards)).toEqual([]);
    });

    it('treats a dependency on a merged card as satisfied', () => {
        const cards = [card('0001', 'merged'), card('0002', 'implementing', ['0001'])];

        expect(unsatisfiedDependencies(cards[1]!, cards)).toEqual([]);
    });

    it('reports a dependency that exists but has not merged yet', () => {
        const cards = [card('0001', 'implementing'), card('0002', 'planning', ['0001'])];

        expect(unsatisfiedDependencies(cards[1]!, cards)).toEqual(['0001']);
    });

    it('treats a dependency on a card missing from the board entirely as outstanding, not as fine', () => {
        const cards = [card('0002', 'planning', ['9999'])];

        expect(unsatisfiedDependencies(cards[0]!, cards)).toEqual(['9999']);
    });

    it('names only the outstanding ids, in dependsOn order, when a card has a mix of merged and pending', () => {
        const cards = [
            card('0001', 'merged'),
            card('0002', 'implementing'),
            card('0003', 'testing'),
            card('0004', 'planning', ['0003', '0001', '0002']),
        ];

        expect(unsatisfiedDependencies(cards[3]!, cards)).toEqual(['0003', '0002']);
    });
});
