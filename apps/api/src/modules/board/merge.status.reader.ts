import { Injectable } from 'injectkit';
import { githubTrackingRef } from '#modules/github/github.remote.js';
import { DRY_RUN_ENABLED } from '#modules/settings/dry.run.setting.js';
import { MERGE_OPENS_PULL_REQUEST } from '#modules/settings/merge.pull.request.setting.js';
import { RE_REVIEW_ON_MERGE } from '#modules/settings/re.review.on.merge.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { MergeStatus } from '../../generated/board.js';
import { RE_REVIEW_CAP } from './re.review.js';

/** Plenty for a board's `ready` cards across a few moves of `main`; the oldest answers go first. */
const MAX_CACHED_MERGES = 256;

interface MergeFacts {
    hasConflict: boolean;
    conflicts: string[];
    movedUnder: string[];
}

/**
 * What pressing Merge on a `ready` card would do, without doing any of it.
 *
 * Computed on read rather than by a job: an operator fast-forwarding `main` emits no event, so
 * anything recorded earlier would go stale without notice. The git answer for a pair of commits never
 * changes, so it is cached by `(targetSha, branchSha)` and a board poll costs a few `rev-parse`s. The
 * settings are read every time and stay out of the cache, so flipping one takes effect at once.
 *
 * Moves no ref and no file. `merge-tree --write-tree` leaves unreferenced objects behind for `git gc`,
 * which is why this never calls {@link WorktreeManager.ensureIntegrationBranch}: that one creates a
 * branch. `BoardWriteService.merge` is the logic this must agree with, re-review check first included.
 */
@Injectable()
export class MergeStatusReader {
    private readonly cache = new Map<string, Promise<MergeFacts>>();

    constructor(
        private readonly worktrees: WorktreeManager,
        private readonly settings: SettingsStore,
    ) {}

    /**
     * Never throws: a board list must not fail because one card's branch is missing.
     *
     * `reReviewRounds` is how many times the card has already been sent back, since Merge stops
     * sending it at {@link RE_REVIEW_CAP} and flags a human instead.
     */
    async read(branch: string, reReviewRounds = 0): Promise<MergeStatus> {
        let target: string | undefined;
        try {
            target = await this.target();
            const targetSha = await this.worktrees.shaOf(target);
            const branchSha = await this.worktrees.shaOf(branch).catch(() => {
                throw new Error(`branch ${branch} is not in the code repo`);
            });
            const facts = await this.factsFor(targetSha, branchSha);
            return { state: await this.stateFrom(facts, reReviewRounds), target, conflicts: facts.conflicts, movedUnder: facts.movedUnder };
        } catch (err) {
            return { state: 'unknown', target, conflicts: [], movedUnder: [], reason: err instanceof Error ? err.message : String(err) };
        }
    }

    /**
     * The ref Merge would prove against: GitHub's `main` as last fetched when merges open pull
     * requests and it has been fetched, otherwise what {@link WorktreeManager.peekMergeTarget} says.
     * Never fetches: a board read must not reach GitHub.
     */
    private async target(): Promise<string> {
        const dryRun = await this.settings.get(DRY_RUN_ENABLED);
        if (!dryRun && (await this.settings.get(MERGE_OPENS_PULL_REQUEST))) {
            const tracking = githubTrackingRef('main');
            if (
                await this.worktrees.shaOf(tracking).then(
                    () => true,
                    () => false,
                )
            ) {
                return tracking;
            }
        }
        return this.worktrees.peekMergeTarget(dryRun);
    }

    private async stateFrom(facts: MergeFacts, reReviewRounds: number): Promise<MergeStatus['state']> {
        if (facts.movedUnder.length > 0 && (await this.settings.get(RE_REVIEW_ON_MERGE))) {
            return reReviewRounds >= RE_REVIEW_CAP ? 'capped' : 'rereview';
        }
        return facts.hasConflict ? 'conflict' : 'clean';
    }

    /** One git run per pair of commits, however many reads arrive at once. A failure is not kept. */
    private factsFor(targetSha: string, branchSha: string): Promise<MergeFacts> {
        const key = `${targetSha}:${branchSha}`;
        const cached = this.cache.get(key);
        if (cached) return cached;

        const facts = this.compute(targetSha, branchSha);
        this.cache.set(key, facts);
        facts.catch(() => this.cache.delete(key));
        if (this.cache.size > MAX_CACHED_MERGES) this.cache.delete(this.cache.keys().next().value!);
        return facts;
    }

    private async compute(targetSha: string, branchSha: string): Promise<MergeFacts> {
        const merge = await this.worktrees.computeMerge(branchSha, targetSha);
        const overlap = await this.worktrees.overlapSinceFork(branchSha, targetSha);
        return { hasConflict: !merge.ok, conflicts: merge.ok ? [] : merge.conflicts, movedUnder: overlap.movedUnder };
    }
}
