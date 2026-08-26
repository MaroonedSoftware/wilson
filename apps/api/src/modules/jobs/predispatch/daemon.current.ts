import { git } from '#modules/board/git.js';
import { commitsBehind } from '#modules/health/health.service.js';
import { buildHead } from '#src/server/build.info.js';
import type { PreDispatchCheck } from './predispatch.check.js';

/**
 * Card 0100. Nothing used to check that this process was running current code before it dispatched a
 * card — `daemonCurrent` (packages/cli/src/checks/daemon.current.ts) only ever ran when a human
 * happened to run `wilson doctor`, and a merge (the moment staleness is created) is a normal part of
 * running the board, not an occasional event a manual check will reliably catch. This runs on every
 * dispatch instead, which is the moment it actually matters.
 *
 * `codeRoot`'s current HEAD is "the commit the card's worktree is about to be cut from": every path
 * through `WorktreeManager` — a fresh `create()`, or a `resume()` immediately followed by
 * `rebaseOntoHead()` — ends with the worktree's `baseSha` equal to that HEAD, so reading it here,
 * before `StageDispatcher.run` ever cuts the tree, needs no change to `StageDispatcher` and no
 * second mechanism for reading the daemon's own commit (`HealthService`'s `buildHead`/
 * `commitsBehind`, card 0079, already answer that).
 *
 * Deliberately never blocks: a daemon one commit behind is the steady state of a running board, not
 * an exceptional one, so this only records what it found and always returns `false`. It is the
 * reason `PreDispatchCheck` returns a boolean rather than being a list of observers — a check that
 * only watches is the special case here, not the general one.
 */
export const checkDaemonCurrent: PreDispatchCheck = async (deps, cardId, stageName) => {
    if (buildHead() === 'unknown') return false;

    const baseSha = await git(deps.board.codeRoot, ['rev-parse', 'HEAD'])
        .then(result => result.stdout.trim())
        .catch(() => undefined);
    if (!baseSha) return false;

    const behindBy = await commitsBehind(deps.board.codeRoot, baseSha);
    if (behindBy <= 0) return false;

    await deps.events.append({
        project: deps.board.project,
        cardId,
        stage: stageName,
        type: 'daemon.stale',
        payload: { daemonCommit: buildHead(), baseCommit: baseSha, behindBy },
    });

    return false;
};
