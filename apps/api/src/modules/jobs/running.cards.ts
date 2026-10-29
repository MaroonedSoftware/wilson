import { Injectable } from 'injectkit';

/** One card this process is mid-run on right now, and which project it is running under. */
export interface RunningCard {
    readonly project: string;
    readonly cardId: string;
}

/** `RunningCard` flattened to the string a `Map` can key on. Card ids are per-project (card 0149's
 * plan: "both boards will have an `0001`"), so the project must be part of the key — keying on
 * `cardId` alone would collapse two different projects' same-id cards into one entry, making
 * whichever finishes first delete the other's still-running one out from under it. */
const key = (project: string, cardId: string): string => `${project}:${cardId}`;

/**
 * Cards this process is mid-run on right now.
 *
 * `wilson.card_jobs` (via `CardJobs`) is the durable claim — which job, if any, is carrying a card,
 * queryable by any process at any time. It does not say which card THIS worker's `card.stage`
 * handler is inside `run()` for at this instant, and that is exactly what a bounded shutdown needs
 * to name: not every claimed card on the board, just the one this process would be abandoning.
 * `CardStageJob.run` adds a card on entry and removes it once the handler settles — normally,
 * permanently-failed, or thrown — so a card still here past a deadline is one whose handler never
 * returned.
 *
 * Card 0149: entries are keyed by `(project, cardId)`, not `cardId` alone, so two projects' `0001`s
 * running at once are two distinct entries — see `key` above.
 */
@Injectable()
export class RunningCards {
    private readonly running = new Map<string, RunningCard>();

    add(project: string, cardId: string): void {
        this.running.set(key(project, cardId), { project, cardId });
    }

    delete(project: string, cardId: string): void {
        this.running.delete(key(project, cardId));
    }

    /** Cards this process was mid-run on at the moment this was called. */
    snapshot(): RunningCard[] {
        return [...this.running.values()];
    }
}
