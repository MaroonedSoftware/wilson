import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { EventLog } from '#modules/events/event.log.js';
import { Notifier } from '#modules/notify/notifier.js';
import { endedAs } from '#modules/stages/terminal.js';

/**
 * Stop a card whose failure retrying cannot fix, wherever that failure was noticed.
 *
 * `poisoned` is a terminal state and deliberately not a kickback: the card's retry budget is for
 * work that came back wrong, and spending it on an exhausted balance or a missing credential both
 * wastes the budget and misreports the cause.
 *
 * Shared: `CardStageJob` calls this the moment a stage's own failure is classified permanent, and
 * `CardStageDeadJob` calls it once a `card.stage` job has exhausted pg-boss's retries instead —
 * same destination, same board write, same event shape, regardless of which noticed the failure.
 *
 * `deps.board` is optional only so a caller with no `BoardConfig` in hand still compiles; every
 * real caller has one already injected, and without it a poisoning cannot notify (card 0050) since
 * that is where `notifyWebhookUrl`/`notifyBaseUrl` live.
 */
export async function poisonCard(
    deps: { boardRepo: BoardRepository; events: EventLog; board?: BoardConfig },
    args: { project: string; cardId: string; stageName: string; reason: string },
): Promise<void> {
    const { project, cardId, stageName, reason } = args;

    // Captured from the fresh row `write` reads inside its own transaction, rather than a separate
    // read here: a notification needs something to call the card, and the id alone is not it. Also
    // the guard below: a card that has already ended, however it ended, keeps that ending. A retried
    // job poisoned it already, or a late one has nothing to stop and must not relabel merged work.
    let title = cardId;
    let ended: string | undefined;
    let endedIn = '';
    await deps.boardRepo.write(cardId, `Poison ${cardId}: ${reason.slice(0, 60)}`, card => {
        title = card.frontmatter.title;
        ended = endedAs(card.frontmatter);
        endedIn = card.frontmatter.stage;
        return ended ? card : { ...card, frontmatter: { ...card.frontmatter, stage: 'poisoned' } };
    });

    if (ended) {
        await deps.events.append({
            project,
            cardId,
            stage: stageName,
            type: 'stage.stale',
            payload: { wantedStage: stageName, actualStage: endedIn },
        });
        return;
    }

    await deps.events.append({
        project,
        cardId,
        stage: stageName,
        type: 'stage.poisoned',
        payload: { reason },
    });

    await deps.events.append({
        project,
        cardId,
        stage: stageName,
        type: 'transition.written',
        payload: { from: stageName, to: 'poisoned', by: 'runner', reason },
    });

    if (deps.board) {
        await new Notifier(deps.board.notifyWebhookUrl, deps.board.notifyBaseUrl).notify({
            project,
            cardId,
            title,
            stage: stageName,
            moment: 'poisoned',
            reason,
        });
    }
}
