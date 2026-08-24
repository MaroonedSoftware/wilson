import { Injectable } from 'injectkit';
import type { AppendableCardEvent } from '#modules/events/event.log.js';
import type { Card } from './card.js';

/**
 * The board.
 *
 * An abstract class rather than an interface so it can be a DI token, and a seam even though one
 * implementation exists (PROJECT.md, "seams, even with one implementation"). Knows nothing about the
 * CLI: a library the CLI drives and the API drives, which is what kept step 6 from being a rewrite.
 *
 * Every mutation goes through `write` or `create`, which snapshot the card into an append-only
 * version and return that version's id. The runner is the sole writer of card state (decision 5).
 */
@Injectable()
export abstract class BoardRepository {
    abstract list(): Promise<Card[]>;

    abstract read(id: string): Promise<Card>;

    /**
     * Read a card as it stood at a specific version.
     *
     * This is how a running stage sees its plan: pinned to `planVersion`, so an edit landing while
     * the stage runs cannot change the contract underneath it. A version snapshots frontmatter and
     * body together, because the dispatcher reads both from the pinned card.
     */
    abstract readAt(id: string, version: string): Promise<Card>;

    /** The most recent version of this card, or undefined if it has none. */
    abstract currentVersion(id: string): Promise<string | undefined>;

    /**
     * Apply a change to one card and record it.
     *
     * Read-modify-write: the mutate callback receives the card as it is right now, not a copy the
     * caller read earlier and may have been holding while something else wrote. Returns the new
     * version id.
     */
    abstract write(id: string, message: string, mutate: (card: Card) => Card | Promise<Card>): Promise<string>;

    /**
     * Write a transition and the event describing it as one operation.
     *
     * This is the reason the board is in Postgres. Previously a transition committed the card file
     * to git and then appended the event here — two stores, sequentially, with no way to reconcile a
     * partial failure. Exposing the pair as a single method rather than a transaction handle the
     * caller must remember to pass makes the invariant structural instead of conventional.
     */
    abstract writeWithEvent(id: string, message: string, mutate: (card: Card) => Card | Promise<Card>, event: AppendableCardEvent): Promise<string>;

    /** Create a card that does not exist yet. Fails if the id is taken. */
    abstract create(card: Card, message: string): Promise<string>;
}
