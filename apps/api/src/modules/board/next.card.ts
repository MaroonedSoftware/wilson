import { NON_STAGE_STATES } from '#modules/stages/stage.config.js';
import type { Card } from './card.js';

export interface Blocked {
    card: Card;
    /** Dependency ids that are not finished, in the order they appear. */
    blockedBy: string[];
}

export interface NextCard {
    next?: Card;
    /** Eligible but for their dependencies, lowest id first. */
    blocked: Blocked[];
}

/**
 * The dependency ids named on `card` that are not yet satisfied, in the order they appear.
 *
 * A dependency is satisfied only when the named card exists on the board and has reached `merged`
 * — a card whose dependency is missing from the board entirely is treated exactly like one whose
 * dependency has not finished, never as "fine". The one place this question is answered; `nextCard`
 * and every other caller go through it so there is no second definition of "blocked" to drift out
 * of sync.
 */
export const unsatisfiedDependencies = (card: Card, cards: Card[]): string[] => {
    const byId = new Map(cards.map(c => [c.frontmatter.id, c]));
    const isFinished = (id: string): boolean => byId.get(id)?.frontmatter.stage === 'merged';
    return card.frontmatter.dependsOn.filter(id => !isFinished(id));
};

/**
 * Pick the next card to work on.
 *
 * A pure function over the whole board: no filesystem, no config, so it can be tested and reasoned
 * about without standing up a repository.
 */
export const nextCard = (cards: Card[]): NextCard => {
    const nonStageStates: readonly string[] = NON_STAGE_STATES;

    const candidates: Card[] = [];
    const blocked: Blocked[] = [];

    for (const card of cards) {
        if (nonStageStates.includes(card.frontmatter.stage)) continue;

        const blockedBy = unsatisfiedDependencies(card, cards);
        if (blockedBy.length === 0) {
            candidates.push(card);
        } else {
            blocked.push({ card, blockedBy });
        }
    }

    candidates.sort((a, b) => (a.frontmatter.id < b.frontmatter.id ? -1 : a.frontmatter.id > b.frontmatter.id ? 1 : 0));
    blocked.sort((a, b) => (a.card.frontmatter.id < b.card.frontmatter.id ? -1 : a.card.frontmatter.id > b.card.frontmatter.id ? 1 : 0));

    return { next: candidates[0], blocked };
};
