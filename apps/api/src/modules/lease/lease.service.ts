import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import { BoardRepository } from '#modules/board/board.repository.js';
import type { DB } from '#modules/data/db.js';

/** Who holds a resource, and which resource — what `acquire` reports back either way. */
export interface LeaseHolder {
    readonly resourceKey: string;
    readonly project: string;
    readonly cardId: string;
}

export type AcquireResult = { readonly acquired: true } | { readonly acquired: false; readonly heldBy: LeaseHolder };

/**
 * Bounds the loop in {@link LeaseService.acquire} that retries after sweeping a stale lease.
 *
 * Not a concurrency limit — under `CARD_STAGE_CONCURRENCY`'s handful of handlers, two callers
 * racing to steal the very same orphaned lease resolve on the first or second iteration (see the
 * loop's own comment). This only guards against looping forever if `runner.leases` is somehow
 * being contested faster than this process can read and act on it, which every acceptance
 * criterion this card ships against gives no reason to expect.
 */
const MAX_ACQUIRE_ATTEMPTS = 3;

/**
 * Card 0165. Whether a card can hold an exclusive claim on a resource that is global to the
 * *machine*, not to a project or a process — a TCP port, a database name — for as long as it
 * holds its worktree. `WorktreeManager.reclaim` (worktree.manager.ts) is the release side: it
 * calls {@link releaseAll} for the card whose worktree just went away, which is what makes "for
 * as long as it holds its worktree" true rather than aspirational.
 *
 * This is the mechanism alone, deliberately unused by anything else in this card — see PROJECT.md
 * card 0165's own Constraints. Picking a port, naming a database, or deciding what a caller does
 * when it loses are all questions for a resource type built on top of this, on its own card.
 */
@Injectable()
export class LeaseService {
    constructor(
        private readonly db: Kysely<DB>,
        private readonly boardRepository: BoardRepository,
    ) {}

    /**
     * Take `resourceKey` for `cardId`, or report who already holds it.
     *
     * The fast path is exactly the primitive card 0165's plan calls for: one
     * `INSERT ... ON CONFLICT DO NOTHING`, which is correct under concurrent callers without an
     * advisory lock because Postgres itself serializes the conflict — there is no read-then-write
     * gap for two racing acquisitions to fall into. Everything below the fast path only runs after
     * a conflict, purely to decide what the conflict *means*; it never decides whether the first
     * attempt should have succeeded.
     *
     * A conflict means one of three things, checked in order:
     *
     * 1. `cardId` already holds `resourceKey` (it asked twice — see the module doc on
     *    `WorktreeManager.reclaim` for why a stage might legitimately do this). Reported as
     *    acquired, not as a loss and not as a second row.
     * 2. Someone else holds it, and is still running. Reported as a loss — the caller is told,
     *    never thrown at, exactly as card 0165's acceptance criteria require.
     * 3. Someone else holds it, but is no longer running (see {@link isOrphaned}'s doc for exactly
     *    what that means and the trade it makes). The stale row is deleted — conditioned on still
     *    finding that exact holder, so two callers racing to steal the same orphaned lease can each
     *    delete it at most once: the loser's `DELETE` matches no row, and its own retried insert
     *    then loses to the winner's, which is the same "loser is told, not thrown" contract a
     *    contested live lease already has — and the loop retries the insert.
     */
    async acquire(resourceKey: string, project: string, cardId: string): Promise<AcquireResult> {
        for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
            if (await this.tryInsert(resourceKey, project, cardId)) return { acquired: true };

            const holder = await this.currentHolder(resourceKey);
            if (!holder) continue; // released between the failed insert and this read — try again

            if (holder.project === project && holder.cardId === cardId) {
                return { acquired: true };
            }

            if (!(await this.isOrphaned(holder))) {
                return { acquired: false, heldBy: holder };
            }

            await this.db
                .deleteFrom('runner.leases')
                .where('resourceKey', '=', resourceKey)
                .where('project', '=', holder.project)
                .where('cardId', '=', holder.cardId)
                .execute();
        }

        throw new Error(`could not resolve a lease acquisition for "${resourceKey}" after ${MAX_ACQUIRE_ATTEMPTS} attempts`);
    }

    /**
     * Release every lease `cardId` holds. Safe to call when it holds none.
     *
     * Called from `WorktreeManager.reclaim` (via its shared `reclaimUnlocked`) so a lease cannot
     * outlive the worktree it was taken for. Scoped by `project` as well as `cardId` because card
     * ids are per-project (card 0149) — without it, releasing card `0001` in one project could
     * release a same-numbered card's leases in another.
     */
    async releaseAll(project: string, cardId: string): Promise<void> {
        await this.db.deleteFrom('runner.leases').where('project', '=', project).where('cardId', '=', cardId).execute();
    }

    /** What is currently held, across every project — the "way to see what is held" card 0165 asks for. */
    async list(): Promise<LeaseHolder[]> {
        return this.db.selectFrom('runner.leases').select(['resourceKey', 'project', 'cardId']).orderBy('resourceKey').execute();
    }

    private async tryInsert(resourceKey: string, project: string, cardId: string): Promise<boolean> {
        const result = await this.db
            .insertInto('runner.leases')
            .values({ resourceKey, project, cardId })
            .onConflict(oc => oc.column('resourceKey').doNothing())
            .executeTakeFirst();
        return result.numInsertedOrUpdatedRows === 1n;
    }

    private async currentHolder(resourceKey: string): Promise<LeaseHolder | undefined> {
        return this.db
            .selectFrom('runner.leases')
            .select(['resourceKey', 'project', 'cardId'])
            .where('resourceKey', '=', resourceKey)
            .executeTakeFirst();
    }

    /**
     * Whether `holder`'s card is no longer running, so its lease is stale rather than genuinely
     * contested — the "orphans must be recoverable without a human" constraint card 0165's plan
     * sets, answered by reconciling against card state rather than inventing a heartbeat, the same
     * shape `reclaimIfTerminal` (board.repository.ts) already uses to sweep a stuck worktree after
     * the fact.
     *
     * `BoardRepository.hasLiveClaim` is "is any job currently carrying this card", which is exactly
     * what a worktree's whole lifetime sits inside: `create`/`resume` only ever run from within
     * `CardStageJob`, and its claim (`CardJobs.record`) is taken before that job starts running —
     * see card.stage.job.ts / board.write.service.ts. So a card with no live claim has no worktree
     * either, whether it finished cleanly (its own claim was already cleared) or a daemon was
     * killed out from under it (nothing is left to clear the claim, and it eventually settles once
     * the broker gives up on the job).
     *
     * The trade: this treats *any* card with no recorded claim as orphaned, including one that
     * acquired a lease outside of a `card.stage` job entirely. That is not a gap for this
     * mechanism's actual contract — a lease is defined as living exactly as long as a card's
     * worktree, and a worktree only exists inside that job — but it does mean a caller that
     * acquires directly, bypassing the job pipeline (as any test of this class necessarily does),
     * finds its lease immediately stealable unless it also records a claim, the same way
     * `card.stage.job.scope.conflict.integration.test.ts` already has to for `hasLiveClaim` itself.
     */
    private async isOrphaned(holder: LeaseHolder): Promise<boolean> {
        return !(await this.boardRepository.hasLiveClaim(holder.project, holder.cardId));
    }
}
