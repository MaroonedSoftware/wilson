import { Mutex } from '#shared/mutex.js';

/**
 * Serializes the git commands that mutate the *code repo's* worktree bookkeeping, in-process.
 *
 * `git worktree add`, `git worktree remove` and `git worktree prune` all run against the single
 * shared `codeRoot`, and `prune` is the one that makes this more than tidiness: it is repo-global
 * rather than scoped to the worktree being reclaimed, so it walks and deletes admin records for
 * every worktree whose directory it cannot see. Run while another card's `add` is partway through
 * registering its own, it is deciding about a worktree that is in the middle of coming into
 * existence. `CARD_STAGE_CONCURRENCY` was 1 when `reclaim` was written, which is why this never
 * mattered before; at 3 there are three handlers issuing these commands at the same `codeRoot`.
 *
 * Only the repo-mutating commands are serialized, not the stage around them and not the work inside
 * a worktree. The read-only queries (`rev-parse`, `merge-base`, `rev-list`) are left out because
 * they mutate nothing, and so is `rebaseOntoHead`, which runs in the card's own worktree directory
 * against the card's own branch ref — git's own per-ref locking already covers two cards rebasing
 * different branches, and holding a repo-wide lock across a rebase would serialize the slow part of
 * every stage for no gain.
 *
 * The same shape as `pnpmStoreLock` (`#modules/stages/run.command.js`) and, like it, a module-level
 * singleton rather than an injectable: it guards a resource that is global to the process — one
 * `codeRoot`, one git — not a resource a container hands out per scope.
 */
export const codeRootLock = new Mutex('code repo lock');
