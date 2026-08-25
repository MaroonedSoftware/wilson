import { Injectable } from 'injectkit';
import type { DateTime } from 'luxon';
import type { AppendableCardEvent, EventLog } from '#modules/events/event.log.js';
import { isTerminal } from '#modules/stages/terminal.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { Card } from './card.js';

/** One row of a card's version history — what `git log` on the board repo used to answer. */
export interface CardVersionSummary {
    id: string;
    message: string;
    createdAt: DateTime;
}

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

    /** This card's version history, newest first, capped at `limit` rows. */
    abstract versions(id: string, limit: number): Promise<CardVersionSummary[]>;

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

    /**
     * Reclaim a card's worktree once a transition has landed it on a terminal stage, and record that
     * it happened.
     *
     * The one place "the card is done" turns into "the worktree goes away" — shared by the runner's
     * own terminal transitions (`StageDispatcher.writeTransition`) and a human's `wilson card move`,
     * so the two callers cannot drift into two definitions of done. `isTerminal(target)` is the
     * runner's own rule; a human override inherits it rather than growing its own idea of "finished".
     *
     * `worktrees` and `events` are passed in rather than injected here: this class has no worktree or
     * event-log dependency of its own, and taking them as parameters lets a caller that already holds
     * both (the dispatcher's constructor fields, or a CLI command's DI container) share this one
     * decision without this abstract class growing dependencies neither its contract nor its Postgres
     * implementation otherwise needs.
     *
     * Never reclaims a flagged card's tree — `args.flagged` must reflect the card's state *before*
     * this transition, even when the transition itself is what clears the flag. Card 0055 keeps a
     * flagged card's worktree on purpose, so a person has something to inspect; that guarantee must
     * hold no matter which caller is the one reaching a terminal state. Do not "fix" this to check the
     * post-transition flag — a card moved straight to a terminal state by the person who is right now
     * looking at the flag is still a card whose tree that flag promised would survive.
     *
     * Best-effort, like the transition it follows: a failure to remove a directory is reported back
     * rather than thrown, so a `writeWithEvent` that already committed is never unwound by a cleanup
     * step failing after the fact. The caller decides how to log it.
     */
    async reclaimIfTerminal(
        worktrees: WorktreeManager,
        events: EventLog,
        args: { project: string; cardId: string; stage: string; target: string; flagged: boolean },
    ): Promise<{ error?: string }> {
        if (!isTerminal(args.target) || args.flagged) return {};

        try {
            await worktrees.reclaim(args.cardId);
            await events.append({
                project: args.project,
                cardId: args.cardId,
                stage: args.stage,
                type: 'worktree.reclaimed',
                payload: { cardId: args.cardId, target: args.target },
            });
            return {};
        } catch (err) {
            return { error: (err as Error).message };
        }
    }
}
