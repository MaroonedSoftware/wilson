import type { Card } from './card.js';

/** One piece of a split, however it was arrived at: confirmed by an operator or taken from a refusal. */
export interface SplitPiece {
    title: string;
    tasks: string[];
    delivers: string;
    dependsOn: string[];
}

/**
 * Why `pieces` cannot be split into, or `undefined` when they can: at least two, unique titles, no
 * piece depending on itself, and every `dependsOn` naming a piece in this same set.
 */
export const splitProblem = (pieces: SplitPiece[]): string | undefined => {
    if (pieces.length < 2) return 'a split needs at least two pieces';

    const titles = new Set(pieces.map(piece => piece.title));
    if (titles.size !== pieces.length) return 'piece titles must be unique';

    for (const piece of pieces) {
        for (const dep of piece.dependsOn) {
            if (dep === piece.title) return `piece "${piece.title}" lists itself as a dependency`;
            if (!titles.has(dep)) return `piece "${piece.title}" depends on "${dep}", which is not one of the pieces being created`;
        }
    }
    return undefined;
};

/**
 * The titles caught in a dependency cycle, in piece order, or `[]` when there is none. Pieces in a
 * cycle wait on each other forever. An operator confirming a split can see and edit that, so
 * {@link splitProblem} stays silent on it; an automatic split has nobody looking, and checks this.
 *
 * Assumes {@link splitProblem} found nothing: every `dependsOn` names a piece here. Repeatedly removes
 * pieces with nothing left to wait on; what cannot be removed is in, or behind, a cycle.
 */
export const dependencyCycle = (pieces: SplitPiece[]): string[] => {
    const resolved = new Set<string>();
    let remaining = pieces;
    for (;;) {
        const free = remaining.filter(piece => piece.dependsOn.every(dep => resolved.has(dep)));
        if (free.length === 0) return remaining.map(piece => piece.title);
        for (const piece of free) resolved.add(piece.title);
        remaining = remaining.filter(piece => !free.includes(piece));
    }
};

/**
 * How many splits `card` is removed from a card that was never split: `0` for that card, `1` for its
 * pieces, and so on along `splitFrom`. A link to a card no longer on the board ends the walk, as does
 * a loop, which `splitFrom` should never hold but which must not hang a stage if it does.
 */
export const splitDepth = (card: Card, cards: Card[]): number => {
    const byId = new Map(cards.map(c => [c.frontmatter.id, c]));
    const seen = new Set([card.frontmatter.id]);
    let depth = 0;
    let parentId = card.frontmatter.splitFrom;
    while (parentId !== undefined && !seen.has(parentId)) {
        depth += 1;
        seen.add(parentId);
        parentId = byId.get(parentId)?.frontmatter.splitFrom;
    }
    return depth;
};

/**
 * The next id on the board. Sequential and zero-padded, matching `nextCardId` in
 * `packages/cli/src/commands/card/editor.ts` — duplicated rather than imported because the
 * dependency runs the other way (`packages/cli` depends on `@wilson/api`, not the reverse).
 */
export const nextCardId = (cards: Card[]): string => {
    const highest = cards.reduce((max, card) => Math.max(max, Number.parseInt(card.frontmatter.id, 10) || 0), 0);
    return String(highest + 1).padStart(4, '0');
};

/**
 * A stub body for a card created from one division piece: what it would deliver, the tasks it
 * carries, and a pointer back to the card it was cut from. Not the six-heading plan contract —
 * `PLAN_SECTIONS` is what `backlog` requires, and this card lands in `planning`, unplanned, on
 * purpose (see `BoardWriteService.split`'s doc comment).
 */
export const seedSplitBody = (originId: string, originTitle: string, piece: { tasks: string[]; delivers: string }): string =>
    [
        `Split from ${originId} (${originTitle}), one piece of a scope-check refusal's division. Not yet planned — run \`wilson card plan\` next.`,
        '',
        '## Delivers',
        '',
        piece.delivers,
        '',
        '## Tasks',
        '',
        ...piece.tasks.map(task => `- ${task}`),
    ].join('\n');
