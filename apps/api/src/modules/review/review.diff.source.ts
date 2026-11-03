import { Injectable } from 'injectkit';
import type { Card } from '#modules/board/card.js';
import { WorktreeManager, type DiffFileEntry } from '#modules/worktree/worktree.manager.js';

/** A change as one commit shows it: every read of it names the same `head`, so a review can bind to it. */
export interface DiffSnapshot {
    /** The commit the patches below end at. */
    head: string;
    base: string;
    files: DiffFileEntry[];
    truncated: boolean;
}

export type DiffResult = ({ ok: true } & DiffSnapshot) | { ok: false; reason: string };

/**
 * Where a card's change under review comes from. The one seam between review and the thing being
 * reviewed: a card's own branch today, and a forge's pull request is a second implementation of this
 * rather than a change to anything that reads one.
 */
export abstract class DiffSource {
    /** The commit a card's change currently ends at, or `undefined` when it has none yet. */
    abstract head(card: Card): Promise<string | undefined>;

    /** The change at `at`, or at its current head when `at` is left out. */
    abstract read(card: Card, at?: string): Promise<DiffResult>;
}

/** A card's own branch since it forked from `main`. Reads git objects, so a reclaimed worktree is no obstacle. */
@Injectable()
export class CardBranchDiffSource extends DiffSource {
    constructor(private readonly worktrees: WorktreeManager) {
        super();
    }

    async head(card: Card): Promise<string | undefined> {
        return this.worktrees.branchHead(this.worktrees.resolveBranch(card));
    }

    async read(card: Card, at?: string): Promise<DiffResult> {
        const branch = this.worktrees.resolveBranch(card);
        const head = at ?? (await this.worktrees.branchHead(branch));
        // With no head, `patchSinceFork` is still asked about the branch, because its refusal is the
        // one that says what a card with no branch yet means.
        const result = await this.worktrees.patchSinceFork(head ?? branch, 'main');
        if (!result.ok) return result;
        return { ok: true, head: head ?? branch, base: result.base, files: result.files, truncated: result.truncated };
    }
}
