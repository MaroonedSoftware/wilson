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
 * Pick the next card to work on.
 *
 * A pure function over the whole board: no filesystem, no config, so it can be tested and reasoned
 * about without standing up a repository. `dependsOn` is a hard block (PROJECT.md) — a card whose
 * dependency is missing from the board entirely is treated exactly like one whose dependency has
 * not finished, never as "fine".
 */
export const nextCard = (cards: Card[]): NextCard => {
    const nonStageStates: readonly string[] = NON_STAGE_STATES;
    const byId = new Map(cards.map(card => [card.frontmatter.id, card]));

    const isFinished = (id: string): boolean => byId.get(id)?.frontmatter.stage === 'merged';

    const candidates: Card[] = [];
    const blocked: Blocked[] = [];

    for (const card of cards) {
        if (nonStageStates.includes(card.frontmatter.stage)) continue;

        const blockedBy = card.frontmatter.dependsOn.filter(id => !isFinished(id));
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
