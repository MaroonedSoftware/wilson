import { describe, expect, it } from 'vitest';
import { dependencyCycle, splitDepth, splitProblem, type SplitPiece } from '#modules/board/split.js';
import type { Card } from '#modules/board/card.js';

const piece = (title: string, dependsOn: string[] = []): SplitPiece => ({ title, tasks: ['a task'], delivers: 'something', dependsOn });

const card = (id: string, splitFrom?: string): Card => ({
    frontmatter: { id, title: id, stage: 'planning', dependsOn: [], retries: {}, ...(splitFrom ? { splitFrom } : {}) },
    sections: {},
    body: '',
});

describe('splitProblem', () => {
    it('accepts two pieces, one depending on the other', () => {
        expect(splitProblem([piece('a'), piece('b', ['a'])])).toBeUndefined();
    });

    it.each([
        ['fewer than two pieces', [piece('a')], 'a split needs at least two pieces'],
        ['repeated titles', [piece('a'), piece('a')], 'piece titles must be unique'],
        ['a self-dependency', [piece('a', ['a']), piece('b')], 'piece "a" lists itself as a dependency'],
        ['an unknown dependency', [piece('a', ['c']), piece('b')], 'piece "a" depends on "c", which is not one of the pieces being created'],
    ])('names %s', (_, pieces, reason) => {
        expect(splitProblem(pieces)).toBe(reason);
    });
});

describe('dependencyCycle', () => {
    it('is empty for a chain and for independent pieces', () => {
        expect(dependencyCycle([piece('c', ['b']), piece('b', ['a']), piece('a')])).toEqual([]);
        expect(dependencyCycle([piece('a'), piece('b')])).toEqual([]);
    });

    it('names the pieces that can never start', () => {
        expect(dependencyCycle([piece('free'), piece('a', ['b']), piece('b', ['a'])])).toEqual(['a', 'b']);
    });
});

describe('splitDepth', () => {
    const board = [card('1'), card('2', '1'), card('3', '2')];

    it('counts the splitFrom links back to a card that was never split', () => {
        expect(splitDepth(board[0]!, board)).toBe(0);
        expect(splitDepth(board[1]!, board)).toBe(1);
        expect(splitDepth(board[2]!, board)).toBe(2);
    });

    it('counts a link to a card no longer on the board, then stops', () => {
        expect(splitDepth(card('9', '8'), [])).toBe(1);
    });

    it('terminates on a loop', () => {
        const loop = [card('1', '2'), card('2', '1')];
        expect(splitDepth(loop[0]!, loop)).toBe(1);
    });
});
