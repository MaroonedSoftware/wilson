/**
 * How commits move between this machine's code repo and a host's clone of it.
 *
 * `WorktreeManager` pushes the base a card's worktree is cut from, and fetches the branch a stage
 * committed on the host back here, where merges, the diff view and every later stage read it. What
 * carries those commits depends on how the host is reached, so the manager asks the placement's
 * transport rather than knowing itself. Today the only one is `SshGitTransport`
 * (`ssh.git.transport.ts`): git's own push and fetch, over the same connection the host's commands use.
 *
 * Both calls run git in `localRepo`, this machine's code repo, and `remoteRepo` is the host's clone
 * as a path on the host. Both reject with whatever the transfer failed with; the caller adds which
 * host it was.
 */
export interface GitTransport {
    /** Push `refspecs` from `localRepo` to the host's clone at `remoteRepo`, without running hooks. */
    push(localRepo: string, remoteRepo: string, refspecs: readonly string[]): Promise<void>;

    /** Fetch `refspecs` from the host's clone at `remoteRepo` into `localRepo`, without tags. */
    fetch(localRepo: string, remoteRepo: string, refspecs: readonly string[]): Promise<void>;
}
