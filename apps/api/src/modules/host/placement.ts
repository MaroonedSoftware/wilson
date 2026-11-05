import type { InterruptedAttempt } from '#modules/agent/stage.interrupt.js';
import type { ExecutionHost } from './execution.host.js';
import type { GitTransport } from './git.transport.js';

/**
 * Where a card's stage runs when it is not this machine: the host, how commits reach it, the
 * project's three paths there, and the slot lease that holds a place on it.
 *
 * Carried on the `Worktree` the stage gets, so everything downstream of the dispatcher (the tools,
 * the verifiers, the commit) reaches the same machine without being told twice.
 */
export interface RemotePlacement {
    /** The host's registered name, as `wilson.hosts` and events record it. */
    hostName: string;
    host: ExecutionHost;
    /** Pushes commits to the host's clone and fetches the branch back. */
    git: GitTransport;
    /** The project's clone on the host, which the card's worktree is cut from. */
    codeRoot: string;
    worktreeRoot: string;
    runRoot: string;
    /** The `wilson.leases` key holding this stage's slot. Released when the worktree is reclaimed. */
    slotKey: string;
}

/**
 * A placed stage's host stopped answering partway through: deleted at the end of its lifetime, its
 * tunnel dropped, or the machine gone. Not the card's failure, so nothing about it is a kickback, and
 * `CardStageJob` sends the stage again without spending a retry. Placement passes the host over until
 * a probe passes again, which for a worker is the next time it connects, so it can be chosen again.
 *
 * Its message avoids every pattern `isPermanentFailure` matches, so a caller that does not handle it
 * still classifies it as a retry.
 */
export class HostLostError extends Error {
    /** Where the stage had got to, when it was running: what to resume instead of the attempt it started from. */
    readonly attempt?: InterruptedAttempt;

    constructor(
        readonly hostName: string,
        readonly detail: string,
        options?: { cause?: unknown; attempt?: InterruptedAttempt },
    ) {
        super(`host ${hostName} stopped answering during the stage, so the stage will be sent again: ${detail}`, options);
        this.name = 'HostLostError';
        this.attempt = options?.attempt;
    }
}

/**
 * What every stage slot's `wilson.leases` key contains. A slot belongs to a stage, not a worktree:
 * the dispatcher takes it before the worktree is cut and releases it when the stage ends, so
 * `LeaseService.releaseAll`, which ends a worktree's leases, leaves slots alone.
 */
export const SLOT_KEY_MARKER = ':slot:';

/** The `wilson.leases` key for one slot on a host. Machine-wide, like every lease key. */
export const hostSlotKey = (hostName: string, slot: number): string => `host:${hostName}${SLOT_KEY_MARKER}${slot}`;

/** The `wilson.leases` key for one of this machine's `local-stage-slots`. */
export const localSlotKey = (slot: number): string => `local${SLOT_KEY_MARKER}${slot}`;
