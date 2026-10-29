import type { ExecutionHost } from './execution.host.js';

/**
 * Where a card's stage runs when it is not this machine: the host, how to reach it, the project's
 * three paths there, and the slot lease that holds a place on it.
 *
 * Carried on the `Worktree` the stage gets, so everything downstream of the dispatcher (the tools,
 * the verifiers, the commit) reaches the same machine without being told twice.
 */
export interface RemotePlacement {
    /** The host's registered name, as `runner.hosts` and events record it. */
    hostName: string;
    /** What `ssh` and git connect to. */
    sshTarget: string;
    host: ExecutionHost;
    /** `GIT_SSH_COMMAND` for pushing commits to the host's clone and fetching the branch back. */
    gitSsh: string;
    /** The project's clone on the host, which the card's worktree is cut from. */
    codeRoot: string;
    worktreeRoot: string;
    runRoot: string;
    /** The `runner.leases` key holding this stage's slot. Released when the worktree is reclaimed. */
    slotKey: string;
}

/** The `runner.leases` key for one slot on a host. Machine-wide, like every lease key. */
export const hostSlotKey = (hostName: string, slot: number): string => `host:${hostName}:slot:${slot}`;
