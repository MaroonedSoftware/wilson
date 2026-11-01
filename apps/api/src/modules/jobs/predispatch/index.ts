import { checkDaemonCurrent } from './daemon.current.js';
import { holdWhileDraining } from './hold.while.draining.js';
import { deferOnScopeConflict } from './scope.conflict.js';
import type { PreDispatchCheck } from './predispatch.check.js';

/**
 * Everything asked before a card's stage is dispatched, in the order it is asked.
 *
 * Two entries is where a list starts paying for itself: both arrived as separate cards (0100, 0104),
 * and both did the same thing to `CardStageJob` — a call at the top of `runStage` and a method at
 * the bottom of the class. A third would have made the same edit in the same two places. Here it is
 * a file and one line.
 *
 * Order is deliberate and not alphabetical. `checkDaemonCurrent` only observes, so it must run
 * before anything that can stop the dispatch — a card deferred for a scope conflict on a stale
 * daemon should still leave the `daemon.stale` record behind, since that is a fact about this
 * process rather than about this card. `holdWhileDraining` goes ahead of the scope check, because a
 * held card is not dispatching, so whether it conflicts with another is not yet a question.
 */
export const PRE_DISPATCH_CHECKS: readonly PreDispatchCheck[] = [checkDaemonCurrent, holdWhileDraining, deferOnScopeConflict];

export type { PreDispatchCheck, PreDispatchDeps } from './predispatch.check.js';
