import { join } from 'node:path';
import { gitOn } from '#modules/board/git.js';
import { snapshotDrift, worktreeHost, type Worktree, type WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { runConfiguredCommandForOutput } from './run.command.js';

/** The most changed files one review's revert proof puts back, so it fits beside the other evidence. */
export const MAX_REVERT_PROOF_FILES = 8;

/** A path a revert proof leaves alone: a test or a document says nothing on its own about behaviour. */
export const isRevertProofExempt = (path: string): boolean =>
    /(^|\/)(tests?|__tests__)\//.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /\.(md|mdx|txt|snap|lock)$/.test(path) ||
    /(^|\/)pnpm-lock\.yaml$/.test(path);

/** What putting each changed file back showed. */
export type RevertProof =
    | {
          status: 'computed';
          command: string;
          /** Files whose old version left every check passing: no check notices them. */
          unnoticed: string[];
          /** Files a check failed for once they were put back. */
          noticed: string[];
          /** Changed files not tried, past {@link MAX_REVERT_PROOF_FILES} or out of time. */
          skipped: string[];
      }
    | { status: 'failed'; reason: string };

interface RevertProofDeps {
    worktrees: Pick<WorktreeManager, 'uncommittedSnapshot'>;
}

/** The card's changed files a revert proof can put back: added or modified since the fork point, tests and docs aside. */
const candidates = async (worktree: Worktree): Promise<{ path: string; added: boolean }[]> => {
    const { stdout } = await gitOn(worktreeHost(worktree), worktree.path, ['diff', '--no-renames', '--name-status', worktree.baseSha, 'HEAD']);
    return stdout
        .split('\n')
        .map(line => line.split('\t'))
        .filter(([status, path]) => (status === 'A' || status === 'M') && path !== undefined && !isRevertProofExempt(path))
        .map(([status, path]) => ({ path: path!, added: status === 'A' }));
};

/** Put one file back to how it was at the fork point: its old version, or nothing for a file the card added. */
const putBack = async (worktree: Worktree, path: string, added: boolean): Promise<void> => {
    const host = worktreeHost(worktree);
    if (added) {
        await gitOn(host, worktree.path, ['--literal-pathspecs', 'rm', '-q', '--cached', '--', path]);
        await host.removeTree(join(worktree.path, path));
    } else {
        await gitOn(host, worktree.path, ['--literal-pathspecs', 'checkout', worktree.baseSha, '--', path]);
    }
};

/** Bring one file back to the branch's version, in the index and the tree. */
const restore = (worktree: Worktree, path: string): Promise<unknown> =>
    gitOn(worktreeHost(worktree), worktree.path, ['--literal-pathspecs', 'checkout', 'HEAD', '--', path]);

/**
 * Cheap mutation testing: for each file the card changed, put only that file back to its pre-card
 * version and run `command`. A file whose old version still passes every check is one no check
 * notices, so nothing would catch it if the change in it were wrong. Evidence for the reviewer, never
 * a gate: a test that only checks types, or a change that is pure refactoring, legitimately goes
 * unnoticed, and the reviewer weighs which it is.
 *
 * Runs in the review's own tree and leaves it exactly as it found it: each file is restored after
 * its run, and anything the command wrote is put back with `revertWrites`. Gives up rather than
 * guessing when the checks already fail on the branch as it is, since then every file looks noticed.
 */
export const computeRevertProof = async (
    deps: RevertProofDeps,
    worktree: Worktree,
    command: string,
    remaining: () => number,
    revertWrites: (worktree: Worktree, before: Record<string, string>, drifted: string[]) => Promise<void>,
): Promise<RevertProof> => {
    const host = worktreeHost(worktree);
    const run = async (): Promise<'pass' | 'fail' | 'late'> => {
        const before = await deps.worktrees.uncommittedSnapshot(worktree);
        const output = await runConfiguredCommandForOutput(worktree.path, command, remaining(), undefined, host);
        const drifted = snapshotDrift(before, await deps.worktrees.uncommittedSnapshot(worktree));
        if (drifted.length > 0) await revertWrites(worktree, before, drifted);
        if (output.killed) return 'late';
        return output.exitCode === 0 ? 'pass' : 'fail';
    };

    try {
        const files = await candidates(worktree);
        if (files.length === 0) return { status: 'computed', command, unnoticed: [], noticed: [], skipped: [] };

        const onBranch = await run();
        if (onBranch !== 'pass') {
            return {
                status: 'failed',
                reason:
                    onBranch === 'late'
                        ? `\`${command}\` did not finish in time on the branch`
                        : `\`${command}\` already fails on the branch, so every file would look noticed`,
            };
        }

        const unnoticed: string[] = [];
        const noticed: string[] = [];
        const skipped: string[] = [];
        for (const [index, { path, added }] of files.entries()) {
            if (index >= MAX_REVERT_PROOF_FILES || remaining() <= 0) {
                skipped.push(path);
                continue;
            }
            await putBack(worktree, path, added);
            let outcome: Awaited<ReturnType<typeof run>>;
            try {
                outcome = await run();
            } finally {
                await restore(worktree, path);
            }
            if (outcome === 'late') skipped.push(path);
            else (outcome === 'pass' ? unnoticed : noticed).push(path);
        }
        return { status: 'computed', command, unnoticed, noticed, skipped };
    } catch (err) {
        return { status: 'failed', reason: (err as Error).message };
    }
};
