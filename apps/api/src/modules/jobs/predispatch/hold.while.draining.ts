import { Duration } from 'luxon';
import { DRAIN_ENABLED } from '#modules/settings/drain.enabled.setting.js';
import type { PreDispatchCheck } from './predispatch.check.js';

/** How long a held job waits before asking again, which is also the longest a resume can take. */
export const DRAIN_HOLD = Duration.fromObject({ seconds: 30 });

/**
 * Keeps a `card.stage` job from dispatching while the server drains (`DRAIN_ENABLED`). Every stage
 * arrives here as one job, whether from the poller, `wilson card start`, a chain or a retry, so this
 * one check holds all of them.
 *
 * The job is sent again for later rather than waited on, because a handler left waiting is an
 * `active` job, and the boot sweep (`sweepOrphanedCardStageJobs`) fails those. A job in `created`
 * sits out a restart untouched and spends no retry. The claim moves to the new job, so the card stays
 * in flight throughout and resuming needs nothing beyond turning the setting off.
 *
 * A failed setting read is treated as not draining, per `PreDispatchCheck`. A failed `send` is the
 * exception and is left to throw: this job has not dispatched, so a retry is safe, while returning
 * here would complete it with nothing left carrying the card.
 */
export const holdWhileDraining: PreDispatchCheck = async (deps, cardId, stageName) => {
    let draining: boolean;
    try {
        draining = await deps.settings.get(DRAIN_ENABLED);
    } catch {
        return false;
    }
    if (!draining) return false;

    const jobId = await deps.broker.send('card.stage', { cardId, stageName, project: deps.board.project }, { startAfter: DRAIN_HOLD });
    await deps.cardJobs.record(cardId, jobId);

    // One line per hold, not one every `DRAIN_HOLD`.
    const [latest] = await deps.events.tail(deps.board.project, cardId, 1).catch(() => []);
    if (latest?.type !== 'dispatch.deferred' || latest.payload.held !== true) {
        await deps.events.append({
            project: deps.board.project,
            cardId,
            stage: stageName,
            type: 'dispatch.deferred',
            payload: { reason: `${cardId} held: the server is draining`, held: true },
        });
    }
    return true;
};
