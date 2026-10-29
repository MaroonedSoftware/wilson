import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import { conflictingPaths, git, gitOn, isClean, mergeTree } from '#modules/board/git.js';
import type { ExecutionHost } from '#modules/host/execution.host.js';
import { localHost } from '#modules/host/local.execution.host.js';
import type { RemotePlacement } from '#modules/host/placement.js';
import { LeaseService } from '#modules/lease/lease.service.js';
import { codeRootLock } from './code.root.lock.js';

export interface Worktree {
    /** Absolute path to the worktree root. Every agent tool is confined to this. */
    path: string;
    branch: string;
    /** The commit the branch was cut from, used to diff what the stage actually changed. */
    baseSha: string;
    /**
     * The machine `path` is on. Read it with {@link worktreeHost}. Unset means this one; optional so
     * the many tests that build a `Worktree` by hand keep meaning what they always meant.
     */
    host?: ExecutionHost;
    /**
     * Set when the worktree was cut on another host: where, and the slot it holds there. Its `host`
     * is the same one as `host` above. Unset for a worktree on this machine.
     */
    placement?: RemotePlacement;
}

/** The host a worktree's files and commands live on: its own, or this machine when it names none. */
export const worktreeHost = (worktree: Worktree): ExecutionHost => worktree.host ?? localHost;

/** Card 0265. One file changed in {@link WorktreeManager.patchSinceFork}'s range. */
export interface DiffFileEntry {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    /** Unified patch text for this file alone, empty when `truncated` is true. */
    patch: string;
    /** True when this file's own patch exceeded the per-file cap, or the response's total patch
     * budget was already spent by the time this file was reached. */
    truncated: boolean;
}

/**
 * Card 0265. Per-file cap on {@link WorktreeManager.patchSinceFork}'s patch text — "Bounded
 * response" in this card's Constraints. Review has read a 33 file, ~2600 line diff (the reasoning
 * recorded on `review.maxSteps` in the stage config), so this sits well above a real card and only
 * exists to keep a lockfile or a generated file from reaching the browser whole.
 */
const MAX_FILE_PATCH_BYTES = 256 * 1024;

/** Card 0265. Total cap across every file's patch text in one {@link WorktreeManager.patchSinceFork} response. */
const MAX_TOTAL_PATCH_BYTES = 2 * 1024 * 1024;

/**
 * Card 0265. Maps `git diff --name-status`'s single-letter status to the wire enum.
 * `patchSinceFork` always diffs `--no-renames`, so only `A`/`D`/`M` are ever seen in practice —
 * anything else (a type change, say) reads as `modified` rather than growing the enum for a case
 * this board has never hit.
 */
const diffStatus = (letter: string): DiffFileEntry['status'] => {
    if (letter === 'A') return 'added';
    if (letter === 'D') return 'deleted';
    return 'modified';
};

/**
 * Card 0144. The one throwaway branch every dry-run merge lands on, across every card — not
 * per-card, so a dependent card's dry-run merge sees its dependency's dry-run result on it (see
 * {@link WorktreeManager.ensureIntegrationBranch}).
 */
export const DRY_RUN_INTEGRATION_BRANCH = 'dry-run-integration';

/**
 * One worktree and one branch per card (PROJECT.md decision 6).
 *
 * The worktree is cut from the *code* repo, which contains no board files at all — that is what
 * makes "a card branch never touches board state" structural rather than merely enforced.
 *
 * A failed stage's work is uncommitted, not lost. Only a passing stage commits (see `commit`), so
 * a failed attempt's work lives only as uncommitted changes in the worktree — and `reclaim` deletes
 * that worktree before the next attempt, on every route in (`create`, `resume`, a terminal card's
 * own reclaim). Before it deletes, it saves whatever is dirty as a patch at
 * `failedAttemptPatchPath(cardId)`, so "uncommitted" never quietly becomes "gone" (card 0089).
 */
@Injectable()
export class WorktreeManager {
    // `leases` is optional so a test that constructs this class directly — bypassing DI, the way
    // most of this class's own tests and several others across the suite already do — keeps
    // working unchanged: no service means `reclaimUnlocked` below skips the release step
    // entirely, the same "nothing to release" outcome `releaseAll` itself would report for a card
    // holding none. Production wiring always supplies the real one via DI.
    constructor(
        private readonly config: BoardConfig,
        private readonly logger: Logger,
        private readonly leases?: LeaseService,
    ) {}

    private path(cardId: string): string {
        return join(this.config.worktreeRoot, cardId);
    }

    /**
     * Where `reclaim` saves a card's last failed attempt, if it found uncommitted work to save.
     *
     * One path per card, not one per attempt: each `reclaim` overwrites it, so it names the most
     * recent failure only. It lives under the per-card scratch directory `stage.dispatcher.ts`
     * already materializes plans into — outside every worktree, so it is never mistaken for part
     * of the tree a resumed or verified stage is working from.
     */
    failedAttemptPatchPath(cardId: string): string {
        return join(this.config.runRoot, 'cards', cardId, 'last-failed-attempt.patch');
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
     * The branch that holds a card's work: the recorded `frontmatter.branch` once one exists,
     * otherwise `branchName`'s derivation from the card's current title.
     *
     * This is the one place that answers "which branch is this card's work on" — the dispatcher, the
     * plan service and `wilson card plan` all call this rather than each doing the fallback
     * themselves, so they cannot drift into two different ideas of the card's branch (card 0095).
     *
     * A recorded branch is never recomputed, even when the title that produced it has since changed:
     * once a worktree is cut, the branch it landed on is the fact, and the title is just prose again.
     * `branchName` stays the answer only for a card that has never had a worktree cut for it — every
     * card born before this method existed, and any card up to its own first dispatch.
     */
    resolveBranch(card: Card): string {
        return card.frontmatter.branch ?? this.branchName(card.frontmatter.id, card.frontmatter.title);
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
    async create(cardId: string, branch: string, at?: string, placement?: RemotePlacement): Promise<Worktree> {
        return codeRootLock.run(
            `${cardId} worktree create`,
            message => this.logger.info(message),
            async () => {
                await this.reclaimUnlocked(cardId, placement);
                const baseSha = at ?? (await git(this.config.codeRoot, ['rev-parse', 'HEAD'])).stdout.trim();
                if (placement) {
                    // The host's clone may not have this commit yet: it is this machine's code repo
                    // that merges land in. Pushed to a ref of Wilson's own, so it never moves a
                    // branch someone on the host is working on.
                    await this.pushToHost(placement, [`+${baseSha}:refs/wilson/base/${cardId}`]);
                    return this.addRemoteWorktree(placement, cardId, ['-B', branch], baseSha, branch, baseSha);
                }
                await mkdir(this.config.worktreeRoot, { recursive: true });

                const path = this.path(cardId);

                // -B so a leftover branch from a prior attempt is reset to the base rather than colliding.
                await git(this.config.codeRoot, ['worktree', 'add', '-B', branch, path, baseSha]);
                this.logger.info(`worktree ${path} on ${branch} at ${baseSha.slice(0, 8)}`);
                return { path, branch, baseSha };
            },
        );
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
    async resume(cardId: string, branch: string, placement?: RemotePlacement): Promise<Worktree> {
        if (!(await this.hasWork(branch))) {
            throw new Error(`this stage resumes the card's branch, but ${branch} has no work on it — has an earlier stage run for this card?`);
        }

        return codeRootLock.run(
            `${cardId} worktree resume`,
            message => this.logger.info(message),
            async () => {
                await this.reclaimUnlocked(cardId, placement);
                const baseSha = (await git(this.config.codeRoot, ['merge-base', branch, 'HEAD'])).stdout.trim();
                if (placement) {
                    // The branch as this machine has it, forced: the host's copy is whatever an
                    // earlier stage there left, and this machine's is the one later stages built on.
                    await this.pushToHost(placement, [`+refs/heads/${branch}:refs/heads/${branch}`]);
                    return this.addRemoteWorktree(placement, cardId, [], branch, branch, baseSha);
                }
                await mkdir(this.config.worktreeRoot, { recursive: true });

                const path = this.path(cardId);

                // No -B: the branch stays exactly where the previous stage left it.
                await git(this.config.codeRoot, ['worktree', 'add', path, branch]);
                this.logger.info(`worktree ${path} resumed on ${branch}, forked at ${baseSha.slice(0, 8)}`);
                return { path, branch, baseSha };
            },
        );
    }

    /**
     * Whether the card's branch exists and carries commits of its own.
     *
     * Only a *passing* stage commits, so a branch with work on it is a branch holding the last state
     * that satisfied an exit condition. That makes resuming safe in every case where the branch
     * exists, and is why a first stage cuts from base only when there is nothing to resume.
     */
    async hasWork(branch: string): Promise<boolean> {
        const exists = await git(this.config.codeRoot, ['rev-parse', '--verify', branch]).then(
            () => true,
            () => false,
        );
        if (!exists) return false;

        const { stdout } = await git(this.config.codeRoot, ['rev-list', '--count', `HEAD..${branch}`]);
        return Number(stdout.trim()) > 0;
    }

    /** Remove a card's worktree and its git bookkeeping. Safe to call when there is nothing there. */
    async reclaim(cardId: string, placement?: RemotePlacement): Promise<void> {
        await codeRootLock.run(
            `${cardId} worktree reclaim`,
            message => this.logger.info(message),
            () => this.reclaimUnlocked(cardId, placement),
        );
    }

    /**
     * Bring a branch committed on a host back into this machine's code repo, where merges, the diff
     * view and every later stage read it. Called after `commit` on a remote worktree; a no-op for a
     * worktree on this machine, whose commits are already here.
     */
    async fetchBack(worktree: Worktree): Promise<void> {
        const placement = worktree.placement;
        if (!placement) return;
        await this.transfer(placement, 'fetch', () =>
            placement.git.fetch(this.config.codeRoot, placement.codeRoot, [`+refs/heads/${worktree.branch}:refs/heads/${worktree.branch}`]),
        );
    }

    /**
     * Cut a worktree in the host's clone and describe it. `args` go to `git worktree add` ahead of
     * the path, and `commitish` after it.
     */
    private async addRemoteWorktree(
        placement: RemotePlacement,
        cardId: string,
        args: string[],
        commitish: string,
        branch: string,
        baseSha: string,
    ): Promise<Worktree> {
        const path = posix.join(placement.worktreeRoot, cardId);
        await placement.host.mkdir(placement.worktreeRoot);
        await gitOn(placement.host, placement.codeRoot, ['worktree', 'add', ...args, path, commitish]);
        this.logger.info(`worktree ${path} on ${placement.hostName} on ${branch} at ${baseSha.slice(0, 8)}`);
        return { path, branch, baseSha, host: placement.host, placement };
    }

    /** Push from this machine's code repo to the host's clone. */
    private async pushToHost(placement: RemotePlacement, refspecs: string[]): Promise<void> {
        await this.transfer(placement, 'push', () => placement.git.push(this.config.codeRoot, placement.codeRoot, refspecs));
    }

    /** Run one of the placement's git transfers, naming the host when it fails. */
    private async transfer(placement: RemotePlacement, verb: 'push' | 'fetch', run: () => Promise<void>): Promise<void> {
        try {
            await run();
        } catch (err) {
            const e = err as { stderr?: string; message: string };
            throw new Error(`git ${verb} to ${placement.hostName} failed: ${e.stderr?.trim() || e.message}`, { cause: err });
        }
    }

    /**
     * `reclaim`'s body, without taking `codeRootLock`.
     *
     * `create` and `resume` both start by reclaiming, and both already hold the lock by the time
     * they do — `Mutex` is deliberately not reentrant (see its doc comment), so calling the public
     * `reclaim` from inside them would deadlock rather than nest. Splitting it is the whole cost of
     * that choice, and it buys the lock the ability to tell a second caller from its own holder.
     *
     * Card 0165: releasing the card's leases here, rather than only in the public `reclaim`, means
     * a lease cannot outlive a worktree through any of the three routes that end one — including
     * `create`/`resume`'s own reclaim-before-recreate, so a card whose previous attempt left a
     * lease held (a daemon killed mid-stage, say) frees it the moment that same card is dispatched
     * again, without needing anything to notice first.
     */
    private async reclaimUnlocked(cardId: string, placement?: RemotePlacement): Promise<void> {
        const path = this.path(cardId);
        // Never lets a preservation failure block the reclaim itself: a card that cannot be
        // reclaimed is worse than an attempt that goes unpreserved.
        await this.preserveUncommitted(cardId, path).catch(err => {
            this.logger.warn(`could not preserve uncommitted work for ${cardId} before reclaim: ${(err as Error).message}`);
        });
        // Same "never block the reclaim" contract as the preservation above: a card that cannot be
        // reclaimed is worse than a lease that needs sweeping later (LeaseService.acquire does
        // that sweeping on the next attempt to take it).
        await this.leases?.releaseAll(this.config.project, cardId).catch(err => {
            this.logger.warn(`could not release leases for ${cardId} before reclaim: ${(err as Error).message}`);
        });
        await git(this.config.codeRoot, ['worktree', 'remove', '--force', path]).catch(() => undefined);
        await rm(path, { recursive: true, force: true });
        // Drops records for directories already gone, which is what a killed run leaves behind.
        await git(this.config.codeRoot, ['worktree', 'prune']).catch(() => undefined);

        if (placement) await this.reclaimRemote(cardId, placement);
    }

    /**
     * The same reclaim on a host: save anything uncommitted there to this machine's patch path, then
     * remove the worktree from the host's clone. After the local half, so when a card has a tree in
     * both places the patch kept is the host's, which is the newer one.
     */
    private async reclaimRemote(cardId: string, placement: RemotePlacement): Promise<void> {
        const host = placement.host;
        const path = posix.join(placement.worktreeRoot, cardId);
        await this.preserveUncommitted(cardId, path, host).catch(err => {
            this.logger.warn(`could not preserve uncommitted work for ${cardId} on ${placement.hostName} before reclaim: ${(err as Error).message}`);
        });
        await gitOn(host, placement.codeRoot, ['worktree', 'remove', '--force', path]).catch(() => undefined);
        await host.removeTree(path);
        await gitOn(host, placement.codeRoot, ['worktree', 'prune']).catch(() => undefined);
    }

    /**
     * Save a dirty worktree's uncommitted changes as a patch before `reclaimUnlocked` deletes the
     * tree — the mechanism card 0089 settles on, and deliberately not a stash or an event: a
     * `git stash` on a linked worktree writes `refs/stash` in the *common* git dir (the operator's
     * own repo), unbounded; an event recording which paths changed describes that work existed
     * without keeping it.
     *
     * `git add -A` before diffing, not `git diff HEAD`: the work card 0078 lost — new test files —
     * was untracked, and invisible to a diff against HEAD. Staging is safe here because nothing is
     * committed; the tree is deleted immediately after this returns. Same idiom `commit` already
     * uses one method away.
     *
     * Skips silently when there is no directory to look at, or nothing dirty in it — a passing
     * stage's clean tree leaves no patch, so the success path is unaffected.
     */
    private async preserveUncommitted(cardId: string, path: string, host: ExecutionHost = localHost): Promise<void> {
        const exists = await host.stat(path).then(
            () => true,
            () => false,
        );
        if (!exists) return;
        if (await isClean(path, host)) return;

        await gitOn(host, path, ['add', '-A']);
        const { stdout } = await gitOn(host, path, ['diff', '--cached', '--binary']);

        const patchPath = this.failedAttemptPatchPath(cardId);
        await mkdir(join(this.config.runRoot, 'cards', cardId), { recursive: true });
        await writeFile(patchPath, stdout, 'utf8');
        this.logger.info(`preserved uncommitted work for ${cardId} at ${patchPath}`);
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
     *
     * `--no-verify`: this is the runner's commit of work its own verifier has already passed, not a
     * human's commit, so a project's pre-commit gate has nothing left to check. Without it, a failing
     * hook throws here in a shape `isPermanentFailure` never matches, so the stage retries and
     * dead-letters redoing passing work every attempt only to fail at the same gate again; and a
     * rewriting hook (lint-staged and its kin) changes the tree after the verifier already checked
     * it, breaking the "what a stage wrote is exactly what is uncommitted at verification time"
     * invariant scope enforcement relies on (PROJECT.md, *Whose work a stage is judged on*). Card
     * 0041 (backlog) is the other half: it makes formatting an exit condition so this bypass doesn't
     * quietly drop the check that used to catch unformatted output.
     */
    async commit(worktree: Worktree, message: string): Promise<string | undefined> {
        const host = worktreeHost(worktree);
        await gitOn(host, worktree.path, ['add', '-A']);
        const staged = await gitOn(host, worktree.path, ['diff', '--cached', '--name-only']);
        if (staged.stdout.trim().length === 0) return undefined;

        await gitOn(host, worktree.path, ['commit', '--no-verify', '-m', message]);
        return (await gitOn(host, worktree.path, ['rev-parse', 'HEAD'])).stdout.trim();
    }

    /**
     * Bring the card's branch up to date with the code repo's HEAD.
     *
     * A card that outlives a few merges is otherwise implementing against a world that has moved on.
     * Card 0014 sat six commits behind while its own plan described an adapter that had landed on
     * main in the meantime: the stage could not see it, the review searched the tree and correctly
     * reported it missing, and nothing in the pipeline could tell "this does not exist" apart from
     * "this does not exist *here*".
     *
     * A conflict is not something a retry fixes, so the rebase is aborted and the reason returned
     * rather than leaving a half-rebased worktree behind for the next stage to trip over.
     *
     * No `--no-verify` here, unlike `commit`: a rebase can fire hooks on some configurations too, but
     * what it replays is already-committed work, and a rebase conflict is already classified as
     * permanent rather than retried — neither of the two failure shapes card 0071 exists to prevent
     * applies to this call.
     */
    async rebaseOntoHead(worktree: Worktree): Promise<{ ok: true; baseSha: string } | { ok: false; reason: string }> {
        const head = (await git(this.config.codeRoot, ['rev-parse', 'HEAD'])).stdout.trim();
        if (head === worktree.baseSha) {
            return { ok: true, baseSha: head };
        }
        // A host's clone has to have the commit before its worktree can rebase onto it.
        if (worktree.placement) {
            await this.pushToHost(worktree.placement, [`+${head}:refs/wilson/head`]);
        }

        const behind = (await git(this.config.codeRoot, ['rev-list', '--count', `${worktree.branch}..HEAD`])).stdout.trim();
        this.logger.info(`${worktree.branch} is ${behind} commit(s) behind; rebasing onto ${head.slice(0, 8)}`);

        try {
            await gitOn(worktreeHost(worktree), worktree.path, ['rebase', head]);
        } catch (err) {
            await gitOn(worktreeHost(worktree), worktree.path, ['rebase', '--abort']).catch(() => undefined);
            return {
                ok: false,
                reason: `rebase conflict: ${worktree.branch} cannot be replayed onto ${head.slice(0, 8)} without a human — ${(err as Error).message}`,
            };
        }

        return { ok: true, baseSha: head };
    }

    /**
     * The code repo's current HEAD.
     *
     * Exists so a caller that gets `{ ok: false }` back from `rebaseOntoHead` can name the exact
     * commit the rebase was attempted against, without `rebaseOntoHead` itself having to return it —
     * that function's contract is deliberately left alone (its failure case already explains itself
     * in `reason`); this is a second, independent read for a caller that wants the raw sha too.
     */
    async headSha(): Promise<string> {
        return (await git(this.config.codeRoot, ['rev-parse', 'HEAD'])).stdout.trim();
    }

    /**
     * Card 0143, generalized by card 0144. Compute the merge of `branch` into `targetRef`, entirely
     * in the object database — `codeRoot`'s working tree and index never move; `targetRef` is read
     * with `rev-parse` and nothing else touches it. A clean merge hands back the resulting tree and
     * the two shas {@link commitMerge} needs as parents; a conflicting one hands back the paths it
     * could not resolve — a flag, not a poison, the same shape card 0103 established for a rebase
     * conflict.
     *
     * `targetRef` is a ref name (`main`, or {@link ensureIntegrationBranch}'s branch), not
     * necessarily `codeRoot`'s checked-out branch — card 0144's dry run computes against the
     * integration branch, which is never checked out anywhere (see {@link landMerge}).
     */
    async computeMerge(
        branch: string,
        targetRef: string,
    ): Promise<{ ok: true; treeSha: string; targetSha: string; branchSha: string } | { ok: false; conflicts: string[]; raw: string }> {
        const targetSha = (await git(this.config.codeRoot, ['rev-parse', targetRef])).stdout.trim();
        const branchSha = (await git(this.config.codeRoot, ['rev-parse', branch])).stdout.trim();

        const result = await mergeTree(this.config.codeRoot, targetSha, branchSha);
        if (!result.ok) {
            return { ok: false, conflicts: conflictingPaths(result.output), raw: result.output };
        }
        return { ok: true, treeSha: result.treeSha, targetSha, branchSha };
    }

    /**
     * Card 0238. Whether `main` moved, since the card's review last ran, under files the card
     * itself changed — the gap that lets a merge land a combined diff nobody has read.
     *
     * `git merge-base branch targetRef` is the fork point every dispatch rebases onto, and review
     * is the last stage before `ready`, so that merge-base is exactly the commit review saw
     * (`BoardWriteService.merge`'s Constraints). `movedUnder` is the intersection of what changed
     * on `targetRef` since that point and what changed on `branch` since that point: paths both
     * sides touched, which is what a combined diff would show and a single-sided review would not.
     *
     * Pure git against `codeRoot`'s object database, same as {@link computeMerge} beside it —
     * nothing here reads or writes `codeRoot`'s working tree or index. `targetRef` is a ref name,
     * not necessarily what is checked out (`main` for a real merge, or
     * {@link ensureIntegrationBranch}'s branch under dry run, which descends from `main` the same
     * way), matching every other merge-time git call in this file.
     */
    async overlapSinceFork(branch: string, targetRef: string): Promise<{ base: string; movedUnder: string[] }> {
        const base = (await git(this.config.codeRoot, ['merge-base', branch, targetRef])).stdout.trim();

        const targetChanged = await this.pathsChangedSince(base, targetRef);
        const branchChanged = await this.pathsChangedSince(base, branch);

        const targetSet = new Set(targetChanged);
        const movedUnder = branchChanged.filter(path => targetSet.has(path)).sort();

        return { base, movedUnder };
    }

    /** Paths changed between `base` and `ref`, relative to `codeRoot`. Shared by {@link overlapSinceFork}. */
    private async pathsChangedSince(base: string, ref: string): Promise<string[]> {
        const { stdout } = await git(this.config.codeRoot, ['diff', '--name-only', base, ref, '--']);
        return stdout
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);
    }

    /**
     * Card 0265. The diff behind `ready`'s human gate, read without a terminal: every file `branch`
     * changed since `merge-base(targetRef, branch)`, as unified patch text — one basis for the diff
     * `wilson card diff` already uses (`packages/cli/src/commands/card/diff.command.ts`, this card's
     * Constraints), so a branch forked from an older `targetRef` never reports a file `targetRef`
     * gained since the fork as a deletion this card never made.
     *
     * Pure git against `codeRoot`'s object database, the same shape {@link overlapSinceFork} beside
     * this already establishes: nothing here reads or writes a working tree or index, so this
     * answers for a card whose worktree was already reclaimed.
     *
     * `branch` not existing at all — a card whose branch has never been cut — is the one case this
     * refuses outright, naming it in `reason` rather than answering with an empty `files`: an empty
     * diff would read as "this card changed nothing", a different and false claim (this card's
     * Constraints). `--no-renames` throughout: a rename reads as a delete and an add, exactly what
     * `changedPaths` and the reviewer's own basis already see.
     *
     * Bounded, per this card's Constraints: a file whose own patch exceeds
     * {@link MAX_FILE_PATCH_BYTES} comes back with an empty `patch` and `truncated: true`; once the
     * running total of patch text already included passes {@link MAX_TOTAL_PATCH_BYTES}, every file
     * from that point on gets the same empty-and-truncated treatment and the response-level
     * `truncated` flag is set.
     */
    async patchSinceFork(
        branch: string,
        targetRef: string,
    ): Promise<{ ok: true; base: string; files: DiffFileEntry[]; truncated: boolean } | { ok: false; reason: string }> {
        const exists = await git(this.config.codeRoot, ['rev-parse', '--verify', '--quiet', branch]).then(
            () => true,
            () => false,
        );
        if (!exists) {
            return { ok: false, reason: `${branch} has no branch yet — it has never reached implementing, so there is nothing to diff` };
        }

        const base = (await git(this.config.codeRoot, ['merge-base', targetRef, branch])).stdout.trim();

        const { stdout: nameStatus } = await git(this.config.codeRoot, ['diff', '--name-status', '--no-renames', base, branch, '--']);
        const changed = nameStatus
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                const [letter, ...rest] = line.split('\t');
                return { letter: letter as string, path: rest.join('\t') };
            });

        let totalBytes = 0;
        let truncated = false;
        const files: DiffFileEntry[] = [];

        for (const { letter, path } of changed) {
            const status = diffStatus(letter);

            // Once the total budget is spent, every remaining file gets the same empty-and-truncated
            // treatment without spending a `git diff` call finding out how big it would have been.
            if (truncated) {
                files.push({ path, status, patch: '', truncated: true });
                continue;
            }

            const { stdout: patch } = await git(this.config.codeRoot, ['diff', '--no-renames', base, branch, '--', path]);
            const bytes = Buffer.byteLength(patch, 'utf8');

            if (bytes > MAX_FILE_PATCH_BYTES) {
                files.push({ path, status, patch: '', truncated: true });
                continue;
            }

            if (totalBytes + bytes > MAX_TOTAL_PATCH_BYTES) {
                truncated = true;
                files.push({ path, status, patch: '', truncated: true });
                continue;
            }

            totalBytes += bytes;
            files.push({ path, status, patch, truncated: false });
        }

        return { ok: true, base, files, truncated };
    }

    /**
     * Create the merge commit object from {@link computeMerge}'s result. This alone does not move
     * `targetRef` — the commit is unreferenced until {@link landMerge} points the branch at it, which
     * is deliberate: the caller runs the suite against this commit first and only lands it if that
     * passes (card 0143's own Constraints, *the suite runs against the merged result before the ref
     * moves*).
     */
    async commitMerge(targetSha: string, branchSha: string, treeSha: string, message: string): Promise<string> {
        const { stdout } = await git(this.config.codeRoot, ['commit-tree', treeSha, '-p', targetSha, '-p', branchSha, '-m', message]);
        return stdout.trim();
    }

    /**
     * Move `targetRef` onto `mergeCommit`, compare-and-swap against the sha {@link computeMerge} last
     * saw at that ref, read the ref back to confirm it actually moved, then — only when `targetRef`
     * is the branch actually checked out at `codeRoot` — reconcile the checkout to match.
     *
     * The CAS (`update-ref`'s optional third argument) refuses rather than clobbers if `targetRef`
     * moved while the suite was running against the computed merge — landing on top of a ref this
     * card never proved anything against would be worse than refusing. The read-back matters
     * separately: [[0025]]'s prior art (vibe-kanban#1897) failed *silently* — the symptom was a card
     * stuck at `ready` with no error — and an exit code is not evidence that the ref actually moved.
     *
     * Moving the ref is not the whole job, but only when it is `codeRoot`'s own checkout: `update-ref`
     * on a branch that is checked out moves `HEAD`'s target while leaving `codeRoot`'s working tree
     * and index at the old commit — `git status` would then report every merged file as a staged
     * deletion, a trap indistinguishable from "nothing happened" until an operator commits it.
     * `git read-tree -m -u <targetSha> <mergeCommit>` is the two-way merge that brings both up to
     * date: it preserves any uncommitted edit in `codeRoot` and refuses rather than overwrite one, so
     * a refusal here is reported as a failed merge rather than swallowed — the ref has already moved
     * at that point, but the checkout is left inconsistent with it, which is why this must never be
     * silent.
     *
     * Card 0144's dry run lands on {@link ensureIntegrationBranch}'s branch instead, which is never
     * checked out anywhere — running `read-tree` for it would have nothing to reconcile *against*
     * and would instead rewrite `codeRoot`'s actual checkout (`main`) to a rehearsal no one asked for.
     * That is why this checks what is checked out rather than assuming `targetRef` always is: the
     * distinction the branch it moves and the branch `codeRoot` shows in its working tree can now
     * differ, where before card 0144 they never did.
     */
    async landMerge(targetSha: string, mergeCommit: string, targetRef: string): Promise<{ ok: true } | { ok: false; reason: string }> {
        try {
            await git(this.config.codeRoot, ['update-ref', `refs/heads/${targetRef}`, mergeCommit, targetSha]);
        } catch (err) {
            return { ok: false, reason: `${targetRef} did not move: ${(err as Error).message}` };
        }

        const after = (await git(this.config.codeRoot, ['rev-parse', `refs/heads/${targetRef}`])).stdout.trim();
        if (after !== mergeCommit) {
            return {
                ok: false,
                reason: `update-ref reported success but ${targetRef} points at ${after.slice(0, 8)}, not ${mergeCommit.slice(0, 8)} — the ref did not move`,
            };
        }

        const checkedOut = (await git(this.config.codeRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
        if (checkedOut !== targetRef) {
            return { ok: true };
        }

        try {
            await git(this.config.codeRoot, ['read-tree', '-m', '-u', targetSha, mergeCommit]);
        } catch (err) {
            return {
                ok: false,
                reason: `${targetRef} moved to ${mergeCommit.slice(0, 8)} but codeRoot's checkout could not be reconciled: ${(err as Error).message}`,
            };
        }

        return { ok: true };
    }

    /**
     * Card 0144. The throwaway branch a dry-run merge lands on instead of `main` — cut from `main`
     * the first time a dry run needs it, then left exactly where the last dry-run merge put it.
     * Never reset: a second card's dry-run merge must see the first's result on it, or a dependent
     * card rehearses against a tree that never existed (this card's Constraints), so `main` moving
     * after this branch exists does not reset it either — this always returns the branch's own tip,
     * stale relative to `main` or not. Composing across dry runs is the entire point; resetting
     * whenever `main` moved would throw that away on exactly the cards that most need it preserved.
     *
     * Never checked out anywhere — {@link landMerge} relies on that to know `read-tree` does not
     * apply to it.
     */
    async ensureIntegrationBranch(): Promise<string> {
        const exists = await git(this.config.codeRoot, ['rev-parse', '--verify', `refs/heads/${DRY_RUN_INTEGRATION_BRANCH}`]).then(
            () => true,
            () => false,
        );
        if (!exists) {
            const mainSha = (await git(this.config.codeRoot, ['rev-parse', 'main'])).stdout.trim();
            await git(this.config.codeRoot, ['branch', DRY_RUN_INTEGRATION_BRANCH, mainSha]);
            this.logger.info(`cut ${DRY_RUN_INTEGRATION_BRANCH} from main at ${mainSha.slice(0, 8)}`);
        }
        return DRY_RUN_INTEGRATION_BRANCH;
    }

    /**
     * Paths this stage has touched but not committed, relative to the worktree root.
     *
     * Distinct from `changedPaths`, which measures from the fork point and therefore describes the
     * whole card across every stage. On a resumed branch that list is never empty, so it cannot
     * answer "did *this* stage write anything" — which is exactly what a read-only stage must be
     * held to.
     *
     * `--untracked-files=all` is load-bearing, not tidiness. Without it `git status --porcelain`
     * collapses an untracked directory into one entry — `?? src/modules/`, the topmost new
     * directory, not even the leaf — instead of listing the files beneath it. `ImplementingVerifier`
     * matches every path this returns against the plan's file globs, and no directory satisfies a
     * file glob, so a card that created a directory failed scope-check however its plan was written.
     * Card 0186 lost three attempts to it while the same event's `changedPaths` listed its five
     * declared files correctly — because `changedPaths` never had the bug, reaching for
     * `ls-files --others --exclude-standard` a few lines below. This makes the two agree.
     *
     * The other two callers only ask whether this list is empty (`ReviewVerifier`,
     * `ScopeCheckVerifier`: a read-only stage must write nothing). A collapsed directory and its
     * expanded files are both non-empty, so their verdicts are unchanged; they now name the files
     * rather than the directory when they refuse, which is strictly more useful.
     */
    async uncommittedPaths(worktree: Worktree): Promise<string[]> {
        const { stdout } = await gitOn(worktreeHost(worktree), worktree.path, ['status', '--porcelain', '--untracked-files=all']);
        return stdout
            .split('\n')
            .map(line => line.slice(3).trim())
            .filter(Boolean)
            .sort();
    }

    /** Paths changed on the branch since it was cut, relative to the worktree root. */
    async changedPaths(worktree: Worktree): Promise<string[]> {
        // --diff-filter excludes nothing: a stage that deletes a file is as much a change as one
        // that adds it, and the scope check must see both.
        const host = worktreeHost(worktree);
        const { stdout } = await gitOn(host, worktree.path, ['diff', '--name-only', worktree.baseSha, '--']);
        const tracked = stdout
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean);

        // Untracked files never appear in `git diff`, and a stage that creates a new file and does
        // not stage it would otherwise read as an empty diff — an exit condition satisfied by doing
        // nothing visible.
        const { stdout: untrackedOut } = await gitOn(host, worktree.path, ['ls-files', '--others', '--exclude-standard']);
        const untracked = untrackedOut
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean);

        return [...new Set([...tracked, ...untracked])].sort();
    }

    /**
     * Paths *added* since the branch was cut, relative to the worktree root — tracked adds from
     * `git diff --name-status` plus untracked files, excluding a pre-existing file this card only
     * modified. Distinct from `changedPaths`, which is every kind of change; this narrower list is
     * what `TestingVerifier` needs to judge the test files this card actually wrote, as opposed to
     * one it touched. Kept here rather than left as a direct `git` call in `testing.verifier.ts` so
     * `worktree.baseSha` is dereferenced in one file, not two (PROJECT.md: one basis for the diff).
     */
    async addedPaths(worktree: Worktree): Promise<string[]> {
        const host = worktreeHost(worktree);
        const { stdout } = await gitOn(host, worktree.path, ['diff', '--name-status', worktree.baseSha, '--']);
        const added = stdout
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .filter(line => line.startsWith('A'))
            .map(line => line.split('\t').pop() as string);

        const { stdout: untrackedOut } = await gitOn(host, worktree.path, ['ls-files', '--others', '--exclude-standard']);
        const untracked = untrackedOut
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);

        return [...added, ...untracked];
    }
}
