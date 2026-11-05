/** One row of a card's event log, as much of it as finding an attempt needs. */
export interface AttemptEvent {
    id: string;
    stage: string | null;
    type: string;
    payload: Record<string, unknown>;
}

/** A past attempt at a stage: which event started it, and the tree it started from. */
export interface ResolvedAttempt {
    eventId: string;
    /** The plan version the attempt recorded, on an event written since it began recording one. */
    planVersionId?: string;
    baseSha: string;
    headSha: string;
}

const ENDINGS = new Set(['stage.passed', 'stage.failed']);

const lastOf = (events: readonly AttemptEvent[], matches: (event: AttemptEvent) => boolean): AttemptEvent | undefined =>
    [...events].reverse().find(matches);

/** The attempts at `stage` itself, oldest first. A step of that lane logs under the lane's name too. */
const dispatchesOf = (events: readonly AttemptEvent[], stage: string): AttemptEvent[] =>
    events.filter((event, index) => {
        if (event.type !== 'stage.dispatched' || event.stage !== stage) return false;
        const ending = events.slice(index + 1).find(later => ENDINGS.has(later.type));
        return ending?.payload.step === undefined;
    });

/**
 * Find a past attempt's starting tree from a card's log, oldest event first. `attempt` counts from 1
 * and defaults to the latest.
 *
 * The head is the last commit before the attempt, and the base is the fork point that commit was
 * made on, not the one the attempt was about to rebase onto. A dispatch rebases after its commits
 * were recorded, so pairing the newer base with the older commit would make everything that landed
 * on `main` in between look like the card's own diff. A pair from the same attempt always agrees.
 * With no commit yet, the attempt's own fork point is both.
 *
 * Answers `undefined` when the card has no such attempt or its log has no fork point for it.
 */
export const resolveAttempt = (events: readonly AttemptEvent[], stage: string, attempt?: number): ResolvedAttempt | undefined => {
    const dispatches = dispatchesOf(events, stage);
    const dispatch = attempt === undefined ? dispatches.at(-1) : dispatches[attempt - 1];
    if (!dispatch) return undefined;

    const before = events.slice(0, events.indexOf(dispatch));
    const lastCommit = lastOf(before, event => event.type === 'work.committed' && typeof event.payload.sha === 'string');
    const beforeHead = lastCommit ? before.slice(0, before.indexOf(lastCommit)) : before;
    const fork = lastOf(beforeHead, event => event.type === 'worktree.created' && typeof event.payload.baseSha === 'string');
    if (!fork) return undefined;

    const baseSha = fork.payload.baseSha as string;
    const { planVersionId } = dispatch.payload;
    return {
        eventId: dispatch.id,
        ...(typeof planVersionId === 'string' && { planVersionId }),
        baseSha,
        headSha: lastCommit ? (lastCommit.payload.sha as string) : baseSha,
    };
};
