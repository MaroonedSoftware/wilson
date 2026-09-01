import { recordDeferral } from '../dispatch.deferred.js';
import type { PreDispatchCheck } from './predispatch.check.js';

/**
 * Card 0104. Two cards whose plans (or `request_scope` grants) name the same file could both
 * dispatch — nothing before this asked what else was running before cutting a worktree. This is the
 * same deferral an unsatisfied dependency gets, reused rather than duplicated: no board write, no
 * retry charged, no flag, just a `dispatch.deferred` event and an early return.
 *
 * Runs ahead of `this.dispatcher.run`, not inside `StageDispatcher.assertDispatchable` — every
 * dispatch still reaches it, because every dispatch, poller or `wilson card start`, arrives as one
 * `card.stage` job (see the note on `whyNotDispatchable` in `dispatchable.ts`, which is the
 * CLI/poller-facing half of this same question).
 *
 * Best-effort, the same as `checkDaemonCurrent`: `boardRepo.read`, `stageConfigs.load` or
 * `boardRepo.scopeConflict` failing is treated the same as "no conflict found" rather than thrown —
 * see `PreDispatchCheck` for why every check in this directory works that way. Also skipped entirely
 * when the card has already moved off `stageName` — a stale dispatch is `stage.stale`'s problem, not
 * a scope conflict.
 */
export const deferOnScopeConflict: PreDispatchCheck = async (deps, cardId, stageName) => {
    const card = await deps.boardRepo.read(cardId).catch(() => undefined);
    if (!card || card.frontmatter.stage !== stageName) return false;

    const stages = await deps.stageConfigs.load().catch(() => undefined);
    if (!stages) return false;

    const conflict = await deps.boardRepo.scopeConflict(deps.events, deps.board.project, card, stages).catch(() => undefined);
    if (!conflict) return false;

    const paths = [...new Set(conflict.overlap.flatMap(o => [o.ours, o.theirs]))].join(', ');
    await recordDeferral(deps, {
        cardId,
        stageName,
        outstanding: [conflict.cardId],
        reason: `${cardId} deferred: ${paths} is in flight on ${conflict.cardId}`,
    });
    await deps.cardJobs.clear(cardId);
    return true;
};
