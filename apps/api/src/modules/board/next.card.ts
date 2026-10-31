import { NON_STAGE_STATES } from '#modules/stages/stage.config.js';
import type { Card } from './card.js';

export interface Blocked {
    card: Card;
    /** Dependency ids that are not finished, in the order they appear. */
    blockedBy: string[];
}

export interface NextCard {
    next?: Card;
    /**
     * Every workable candidate, lowest id first — `next` is always `candidates[0]` (or `undefined`
     * when this is empty).
     *
     * `next` alone answers "what's the next thing to do", which is all a human needs. The poller
     * needs more: a card in a manual stage genuinely *is* the next thing for a person, but the queue
     * can never dispatch it, so the poller has to walk past it to the next workable candidate instead
     * of stopping. It walks this list to do that, rather than re-deriving "workable" itself — see
     * `poller.ts` for why that has to stay this function's job and not grow into a second one.
     */
    candidates: Card[];
    /** Eligible but for their dependencies, lowest id first. */
    blocked: Blocked[];
    /** Flagged for a human via `needsHuman`, lowest id first. Never `next`, never in `blocked`. */
    flagged: Card[];
}

/**
 * The dependency ids named on `card` that are not yet satisfied, in the order they appear.
 *
 * A dependency is satisfied only when the named card exists on the board and has reached `merged`
 * — a card whose dependency is missing from the board entirely is treated exactly like one whose
 * dependency has not finished, never as "fine". The one place this question is answered; `nextCard`
 * and every other caller go through it so there is no second definition of "blocked" to drift out
 * of sync.
 *
 * A split origin never merges, so it also counts as finished once it has pieces and every one of
 * them is finished, whatever stage the origin sits in. A dropped piece keeps the origin unfinished:
 * its work was not delivered, so a dependent waits for a person to look.
 */
export const unsatisfiedDependencies = (card: Card, cards: Card[]): string[] => {
    const byId = new Map(cards.map(c => [c.frontmatter.id, c]));
    const isFinished = (id: string): boolean => {
        const dep = byId.get(id);
        if (dep === undefined) return false;
        if (dep.frontmatter.stage === 'merged') return true;
        const pieces = cards.filter(c => c.frontmatter.splitFrom === id);
        return pieces.length > 0 && pieces.every(piece => isFinished(piece.frontmatter.id));
    };
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
    const flagged: Card[] = [];

    for (const card of cards) {
        if (nonStageStates.includes(card.frontmatter.stage)) continue;

        // Flagged first and exclusively: a card waiting on a person is neither the next thing to work
        // on nor merely blocked on a dependency, so it must land in neither of those buckets.
        if (card.frontmatter.needsHuman) {
            flagged.push(card);
            continue;
        }

        const blockedBy = unsatisfiedDependencies(card, cards);
        if (blockedBy.length === 0) {
            candidates.push(card);
        } else {
            blocked.push({ card, blockedBy });
        }
    }

    candidates.sort((a, b) => (a.frontmatter.id < b.frontmatter.id ? -1 : a.frontmatter.id > b.frontmatter.id ? 1 : 0));
    blocked.sort((a, b) => (a.card.frontmatter.id < b.card.frontmatter.id ? -1 : a.card.frontmatter.id > b.card.frontmatter.id ? 1 : 0));
    flagged.sort((a, b) => (a.frontmatter.id < b.frontmatter.id ? -1 : a.frontmatter.id > b.frontmatter.id ? 1 : 0));

    return { next: candidates[0], candidates, blocked, flagged };
};
