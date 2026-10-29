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

/**
 * A placed stage's host stopped answering partway through: deleted at the end of its lifetime, its
 * tunnel dropped, or the machine gone. Not the card's failure, so nothing about it is a kickback; it
 * is thrown for the queue to retry, and placement passes the host over until a probe passes again.
 *
 * Its message avoids every pattern `isPermanentFailure` matches, so it classifies as a retry.
 */
export class HostLostError extends Error {
    constructor(
        readonly hostName: string,
        readonly detail: string,
        options?: { cause?: unknown },
    ) {
        super(`host ${hostName} stopped answering during the stage, so it will be retried elsewhere: ${detail}`, options);
        this.name = 'HostLostError';
    }
}

/**
 * What every stage slot's `runner.leases` key contains. A slot belongs to a stage, not a worktree:
 * the dispatcher takes it before the worktree is cut and releases it when the stage ends, so
 * `LeaseService.releaseAll`, which ends a worktree's leases, leaves slots alone.
 */
export const SLOT_KEY_MARKER = ':slot:';

/** The `runner.leases` key for one slot on a host. Machine-wide, like every lease key. */
export const hostSlotKey = (hostName: string, slot: number): string => `host:${hostName}${SLOT_KEY_MARKER}${slot}`;

/** The `runner.leases` key for one of this machine's `local-stage-slots`. */
export const localSlotKey = (slot: number): string => `local${SLOT_KEY_MARKER}${slot}`;
