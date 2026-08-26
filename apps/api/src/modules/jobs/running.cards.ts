import { Injectable } from 'injectkit';

/**
 * Cards this process is mid-run on right now.
 *
 * `runner.card_jobs` (via `CardJobs`) is the durable claim — which job, if any, is carrying a card,
 * queryable by any process at any time. It does not say which card THIS worker's `card.stage`
 * handler is inside `run()` for at this instant, and that is exactly what a bounded shutdown needs
 * to name: not every claimed card on the board, just the one this process would be abandoning.
 * `CardStageJob.run` adds a card on entry and removes it once the handler settles — normally,
 * permanently-failed, or thrown — so a card still here past a deadline is one whose handler never
 * returned.
 */
@Injectable()
export class RunningCards {
    private readonly cardIds = new Set<string>();

    add(cardId: string): void {
        this.cardIds.add(cardId);
    }

    delete(cardId: string): void {
        this.cardIds.delete(cardId);
    }

    /** Cards this process was mid-run on at the moment this was called. */
    snapshot(): string[] {
        return [...this.cardIds];
    }
}
