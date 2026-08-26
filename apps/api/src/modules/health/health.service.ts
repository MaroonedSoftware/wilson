import { Injectable } from 'injectkit';
import { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import { git } from '#modules/board/git.js';
import { buildHead } from '#src/server/build.info.js';
import type { Health } from '#src/generated/health.js';

/**
 * Captured once, when this module is first loaded — which happens while the process is still
 * bootstrapping, before it can serve a request. Read live it would report the current time on every
 * call instead of when the process actually started, which is the only question `startedAt` exists
 * to answer.
 */
const startedAt = DateTime.utc();

/**
 * What the server reports about itself.
 *
 * `head` is the commit captured at boot rather than the repo's HEAD now. Read per request it would
 * report whatever the code repo points at, which is precisely the commit a stale process is *not*
 * running — so the field that exists to expose a stale daemon would hide one. `startedAt` is the
 * same idea applied to time: card 0079's "daemon not stale" check compares it against the working
 * tree's HEAD commit time to answer "is this process older than the fix on disk" by asking, not by
 * grepping a process table for a command line that assumed there was only ever one daemon.
 */
@Injectable()
export class HealthService {
    constructor(private readonly config: BoardConfig) {}

    get(): Health {
        return {
            ok: true,
            project: this.config.project,
            head: buildHead(),
            startedAt,
            boardRoot: this.config.boardRoot,
            codeRoot: this.config.codeRoot,
            worktreeRoot: this.config.worktreeRoot,
        };
    }
}

/**
 * How many commits behind `ref` this process's own commit is — card 0100's dispatch-time answer to
 * the question `daemonCurrent` (`packages/cli/src/checks/daemon.current.ts`) otherwise only answers
 * when a human runs `wilson doctor`. `ref` is typically the commit a card's worktree is about to be
 * cut from: both it and `buildHead()` live in the history of `codeRoot`, so ancestry answers it
 * directly, without a second mechanism for reading the daemon's own commit — `rev-list --count` of
 * the range between them is exactly the number of commits `ref` has that the running process does
 * not.
 *
 * Zero covers two cases on purpose: the daemon is current, or it is *ahead* of `ref`. Card 0100's
 * "compare like with like" — only "behind" is staleness; a daemon ahead of `ref` has not missed
 * anything `ref` needs, so it gets no different treatment than current.
 *
 * Best-effort, like the check it backs: `buildHead()` reads `'unknown'` before boot finishes
 * capturing it, and a `rev-list` that fails to run (an unreachable `codeRoot`, a repo mid-operation)
 * answers "cannot tell" rather than "stale" — a false alarm here is worse than a missed one, exactly
 * `daemonCurrent`'s own posture when the API itself is unreachable.
 *
 * A bare function, not a method on `HealthService`: the caller (`CardStageJob`) has no board-scoped
 * `HealthService` of its own to inject, only the `codeRoot` its existing `BoardConfig` already
 * carries, and this needs nothing else.
 */
/**
 * The last answer `commitsBehind` computed, per code repo.
 *
 * `head..ref` counts commits between two fixed points in a repo's history, so for a given
 * `(codeRoot, head, ref)` the answer is immutable — not a value that ages, which is why this is a
 * plain memo with no expiry rather than a cache with a staleness policy. `head` is `buildHead()`,
 * captured once at boot and constant for the process's life; `ref` is the code repo's HEAD, which
 * moves only on a merge.
 *
 * One slot per repo rather than an entry per sha, because the only caller (`CardStageJob`'s
 * pre-dispatch check, card 0100) always asks about the *current* HEAD: every dispatch between two
 * merges asks the identical question, and once HEAD moves the previous answer is never wanted
 * again. Keeping every sha ever seen would grow without bound for no additional hit.
 *
 * `head` is stored alongside the answer even though it cannot change after capture. It is what makes
 * the memo self-validating rather than dependent on that argument holding: an entry recorded under a
 * different `head` is simply not a hit.
 */
const lastAnswer = new Map<string, { head: string; ref: string; count: number }>();

export const commitsBehind = async (codeRoot: string, ref: string): Promise<number> => {
    const head = buildHead();
    if (head === 'unknown') return 0;

    const cached = lastAnswer.get(codeRoot);
    if (cached && cached.head === head && cached.ref === ref) return cached.count;

    const result = await git(codeRoot, ['rev-list', '--count', `${head}..${ref}`]).catch(() => undefined);
    if (!result) return 0;

    const count = Number(result.stdout.trim());
    // Only a real count is remembered. Both zeroes above are "cannot tell" — an unreachable
    // `codeRoot`, a repo mid-operation, output that did not parse — and memoising one of those would
    // turn a transient failure into a permanent "the daemon is current", which is the answer this
    // check exists to be able to contradict.
    if (!Number.isFinite(count)) return 0;

    lastAnswer.set(codeRoot, { head, ref, count });
    return count;
};
