import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { EventLog } from '#modules/events/event.log.js';
import { Notifier } from '#modules/notify/notifier.js';
import { RebaseConflictError } from '#modules/stages/stage.dispatcher.js';

/**
 * Flag a card for a human after its branch failed to rebase onto HEAD, without poisoning it or
 * spending a retry.
 *
 * A rebase conflict is not a judgment about the card's code — it has not even run — and not
 * something a retry fixes, so this is deliberately not `poisonCard`'s shape: `frontmatter.stage` is
 * left exactly where it was (the card stays put, not moved to a terminal state), `retries` is
 * untouched (the stage never ran, so it failed nothing), and the worktree is never reclaimed — a
 * human resolving this by hand needs the tree that is sitting there mid-conflict-free-but-unmerged,
 * not a fresh one. That makes this closer in shape to `StageDispatcher.refuseOverBudget`, which
 * flags the same way for the same reason (a card that never got to run), than to `poisonCard`: both
 * use `writeWithEvent` so the flag and the transition record commit together, rather than as two
 * separate writes a redelivered job could observe half-done.
 *
 * `error.message` is already the one sentence an operator needs (composed once, in
 * `RebaseConflictError`), so it is used verbatim as `needsHumanReason` — this function's own job is
 * only to record it and route it, not to re-word it.
 */
export async function flagRebaseConflict(
    deps: { boardRepo: BoardRepository; events: EventLog; board?: BoardConfig },
    args: { project: string; cardId: string; stageName: string; error: RebaseConflictError },
): Promise<void> {
    const { project, cardId, stageName, error } = args;
    const reason = error.message;

    await deps.events.append({
        project,
        cardId,
        stage: stageName,
        type: 'rebase.conflict',
        payload: { branch: error.branch, targetSha: error.targetSha, detail: error.detail },
    });

    // Captured from the fresh row `writeWithEvent` reads inside its own transaction, the same
    // redelivery guard `poisonCard` uses: a job that lands here again after an earlier attempt
    // already flagged this card has nothing new to report.
    let title = cardId;
    let alreadyFlagged = false;
    await deps.boardRepo.writeWithEvent(
        cardId,
        `Flag ${cardId}: rebase conflict on ${error.branch}`,
        card => {
            title = card.frontmatter.title;
            alreadyFlagged = Boolean(card.frontmatter.needsHuman);
            return {
                ...card,
                frontmatter: { ...card.frontmatter, needsHuman: true, needsHumanReason: reason },
            };
        },
        {
            project,
            cardId,
            stage: stageName,
            type: 'transition.written',
            payload: { from: stageName, to: stageName, by: 'runner', needsHuman: true },
        },
    );

    if (deps.board && !alreadyFlagged) {
        await new Notifier(deps.board.notifyWebhookUrl, deps.board.notifyBaseUrl).notify({
            project,
            cardId,
            title,
            stage: stageName,
            moment: 'needs-human',
            reason,
        });
    }
}
