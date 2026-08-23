import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import { git } from '#modules/board/git.js';

export interface Worktree {
    /** Absolute path to the worktree root. Every agent tool is confined to this. */
    path: string;
    branch: string;
    /** The commit the branch was cut from, used to diff what the stage actually changed. */
    baseSha: string;
}

/**
 * One worktree and one branch per card (PROJECT.md decision 6).
 *
 * The worktree is cut from the *code* repo, which contains no board files at all — that is what
 * makes "a card branch never touches board state" structural rather than merely enforced.
 */
@Injectable()
export class WorktreeManager {
    constructor(
        private readonly config: BoardConfig,
        private readonly logger: Logger,
    ) {}

    private path(cardId: string): string {
        return join(this.config.worktreeRoot, cardId);
    }

    branchName(cardId: string, title: string): string {
        const slug = title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40);
        return `card/${cardId}${slug ? `-${slug}` : ''}`;
    }

    /**
     * Create a worktree for a card, reclaiming any stale one first.
     *
     * Reclaiming rather than failing is deliberate: the common reason a worktree already exists is
     * that a previous run died, and a dead run's tree holds artifacts the runner must not verify
     * (PROJECT.md, resume semantics — partial output is never verified).
     *
     * `at` cuts the worktree from a specific commit instead of HEAD — the testing verifier's baseline
     * check uses it to cut from the card worktree's own base, so "pre-change" means exactly what the
     * card branched from rather than whatever HEAD has moved to since.
     */
    async create(cardId: string, branch: string, at?: string): Promise<Worktree> {
        await this.reclaim(cardId);
        await mkdir(this.config.worktreeRoot, { recursive: true });

        const path = this.path(cardId);
        const baseSha = at ?? (await git(this.config.codeRoot, ['rev-parse', 'HEAD'])).stdout.trim();

        // -B so a leftover branch from a prior attempt is reset to the base rather than colliding.
        await git(this.config.codeRoot, ['worktree', 'add', '-B', branch, path, baseSha]);
        this.logger.info(`worktree ${path} on ${branch} at ${baseSha.slice(0, 8)}`);
        return { path, branch, baseSha };
    }

    /**
     * Re-open the card's existing branch, keeping everything earlier stages committed to it.
     *
     * `create` cuts from a commit with `-B`, which *resets* the branch — right for implementing,
     * where every attempt starts from a clean base, and fatal for every stage after it. The testing
     * stage runs on the tree implementing produced; resetting the branch would delete the work it
     * was asked to write tests for.
     *
     * `baseSha` is the fork point rather than the branch tip, so `changedPaths` still describes
     * everything the card has changed since it started, across all of its stages.
     */
    async resume(cardId: string, branch: string): Promise<Worktree> {
        const exists = await git(this.config.codeRoot, ['rev-parse', '--verify', branch]).then(
            () => true,
            () => false,
        );
        if (!exists) {
            throw new Error(`this stage resumes the card's branch, but ${branch} does not exist — has an earlier stage run for this card?`);
        }

        await this.reclaim(cardId);
        await mkdir(this.config.worktreeRoot, { recursive: true });

        const path = this.path(cardId);
        const baseSha = (await git(this.config.codeRoot, ['merge-base', branch, 'HEAD'])).stdout.trim();

        // No -B: the branch stays exactly where the previous stage left it.
        await git(this.config.codeRoot, ['worktree', 'add', path, branch]);
        this.logger.info(`worktree ${path} resumed on ${branch}, forked at ${baseSha.slice(0, 8)}`);
        return { path, branch, baseSha };
    }

    /** Remove a card's worktree and its git bookkeeping. Safe to call when there is nothing there. */
    async reclaim(cardId: string): Promise<void> {
        const path = this.path(cardId);
        await git(this.config.codeRoot, ['worktree', 'remove', '--force', path]).catch(() => undefined);
        await rm(path, { recursive: true, force: true });
        // Drops records for directories already gone, which is what a killed run leaves behind.
        await git(this.config.codeRoot, ['worktree', 'prune']).catch(() => undefined);
    }

    /**
     * Commit whatever the stage produced to the card's branch.
     *
     * Without this a stage's work only ever exists as uncommitted changes in a worktree, and the
     * next stage's `resume` — which reclaims the directory first — deletes it. Committing is what
     * makes the branch the hand-off between stages rather than a label on an empty ref.
     *
     * The runner commits, never the agent: the agent has no git command in its allowlist, and
     * decision 5 makes the runner the sole writer of what a card has produced.
     */
    async commit(worktree: Worktree, message: string): Promise<string | undefined> {
        await git(worktree.path, ['add', '-A']);
        const staged = await git(worktree.path, ['diff', '--cached', '--name-only']);
        if (staged.stdout.trim().length === 0) return undefined;

        await git(worktree.path, ['commit', '-m', message]);
        return (await git(worktree.path, ['rev-parse', 'HEAD'])).stdout.trim();
    }

    /** Paths changed on the branch since it was cut, relative to the worktree root. */
    async changedPaths(worktree: Worktree): Promise<string[]> {
        // --diff-filter excludes nothing: a stage that deletes a file is as much a change as one
        // that adds it, and the scope check must see both.
        const { stdout } = await git(worktree.path, ['diff', '--name-only', worktree.baseSha, '--']);
        const tracked = stdout
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean);

        // Untracked files never appear in `git diff`, and a stage that creates a new file and does
        // not stage it would otherwise read as an empty diff — an exit condition satisfied by doing
        // nothing visible.
        const { stdout: untrackedOut } = await git(worktree.path, ['ls-files', '--others', '--exclude-standard']);
        const untracked = untrackedOut
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean);

        return [...new Set([...tracked, ...untracked])].sort();
    }
}
