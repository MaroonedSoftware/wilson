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

const flaggedCard = (id: string, stage: string, dependsOn: string[] = []): Card => ({
    frontmatter: {
        id,
        title: `Card ${id}`,
        stage,
        dependsOn,
        retries: {},
        needsHuman: true,
    } as CardFrontmatter,
    sections: {},
    body: '',
});

describe('nextCard', () => {
    it('returns no candidate and no blocked cards for an empty board', () => {
        expect(nextCard([])).toEqual({ next: undefined, candidates: [], blocked: [], flagged: [] });
    });

    it('picks the eligible card with the lowest id, compared as a zero-padded string', () => {
        const cards = [card('0010', 'planning'), card('0002', 'implementing'), card('0100', 'testing')];

        const { next } = nextCard(cards);

        expect(next?.frontmatter.id).toBe('0002');
    });

    it('ignores cards in every non-stage state, even when they would otherwise be the lowest id', () => {
        const cards = [card('0001', 'merged'), card('0002', 'parking-lot'), card('0004', 'poisoned'), card('0005', 'dropped'), card('0006', 'implementing')];

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

        expect(nextCard(cards)).toEqual({ next: undefined, candidates: [], blocked: [], flagged: [] });
    });

    // Card 0054: the guards learn about the flag. `nextCard` grows a third bucket so a flagged card
    // can never be `next` and never show up in `blocked` — the runner's "what next" answer must not
    // be a card waiting on a person.
    describe('flagged', () => {
        it('puts a flagged card in flagged, not in next, even when it is the only eligible card', () => {
            const cards = [flaggedCard('0001', 'implementing')];

            const { next, blocked, flagged } = nextCard(cards);

            expect(next).toBeUndefined();
            expect(blocked).toEqual([]);
            expect(flagged.map(c => c.frontmatter.id)).toEqual(['0001']);
        });

        it('picks the lowest-id unflagged candidate as next when a lower-id flagged card exists', () => {
            const cards = [flaggedCard('0001', 'implementing'), card('0002', 'implementing')];

            const { next, flagged } = nextCard(cards);

            expect(next?.frontmatter.id).toBe('0002');
            expect(flagged.map(c => c.frontmatter.id)).toEqual(['0001']);
        });

        it('puts a flagged card with unsatisfied dependencies in flagged, never in blocked', () => {
            const dangling = flaggedCard('0002', 'planning', ['9999']);

            const { blocked, flagged } = nextCard([dangling]);

            expect(blocked).toEqual([]);
            expect(flagged).toEqual([dangling]);
        });

        it('sorts flagged cards by id, lowest first, independent of input order', () => {
            const cards = [flaggedCard('0005', 'implementing'), flaggedCard('0001', 'implementing'), flaggedCard('0003', 'implementing')];

            const { flagged } = nextCard(cards);

            expect(flagged.map(c => c.frontmatter.id)).toEqual(['0001', '0003', '0005']);
        });

        it('still excludes a flagged card sitting in a non-stage state, the same as any other card there', () => {
            const cards = [flaggedCard('0001', 'merged')];

            const { flagged } = nextCard(cards);

            expect(flagged).toEqual([]);
        });
    });
});

// Card 0023: `nextCard`'s blocking question, pulled out so `card list` and `StageDispatcher` can ask
// it about a single card without reimplementing "is this dependency satisfied". These exercise the
// export directly rather than only through `nextCard`'s `blocked` output above, since a caller that
// imports `unsatisfiedDependencies` and gets back the wrong thing would not be caught by any test of
// `nextCard` itself.
describe('unsatisfiedDependencies', () => {
    it('returns an empty array for a card with no dependencies', () => {
        const cards = [card('0001', 'implementing')];

        expect(unsatisfiedDependencies(cards[0]!, cards)).toEqual([]);
    });

    it('returns an empty array when every named dependency has merged', () => {
        const dependency = card('0001', 'merged');
        const dependent = card('0002', 'planning', ['0001']);

        expect(unsatisfiedDependencies(dependent, [dependency, dependent])).toEqual([]);
    });

    it('returns a dependency id whose card exists but has not reached merged', () => {
        const dependency = card('0001', 'implementing');
        const dependent = card('0002', 'planning', ['0001']);

        expect(unsatisfiedDependencies(dependent, [dependency, dependent])).toEqual(['0001']);
    });

    it('treats a dependency id absent from the board as unsatisfied, not as fine', () => {
        const dependent = card('0002', 'planning', ['9999']);

        expect(unsatisfiedDependencies(dependent, [dependent])).toEqual(['9999']);
    });

    it('returns only the outstanding ids, in the order dependsOn names them, when some are satisfied and some are not', () => {
        const merged = card('0001', 'merged');
        const dependent = card('0004', 'testing', ['0003', '0001', '0002']);

        const result = unsatisfiedDependencies(dependent, [merged, dependent]);

        expect(result).toEqual(['0003', '0002']);
    });
});
