import { Injectable } from 'injectkit';
import type { AgentRunOutput } from './stage.agent.js';
import type { LaneDepth } from '#modules/stages/stage.config.js';
import { describeUsageLimit, type UsageLimit } from './usage.limit.js';

/**
 * Tells running engines the daemon is going away, so a stage can stop on its own terms rather than be
 * killed with the process. One per process, and one-way: a daemon that has started shutting down does
 * not come back.
 */
@Injectable()
export class StageInterrupt {
    private readonly controller = new AbortController();

    get signal(): AbortSignal {
        return this.controller.signal;
    }

    /** Safe to call twice: `setupServer` and `BoundedCardStageJobRunner.stop` both do. */
    interrupt(): void {
        this.controller.abort();
    }
}

/** What a stage has used across its interrupted runs, so a restart cannot buy it more of any. */
export interface InterruptedSpend {
    wallClockMs: number;
    steps: number;
    inputTokens: number;
}

/**
 * Where an interrupted stage left off, carried on the job that sends it again. Plain data, since it
 * travels in the job's payload. `host` is unset for a tree on this machine, and `sessionId` for a run
 * stopped before the engine named one. `depth` is the tier it ran on, unset when it ran the lane as
 * written, so going back to it cannot change its model part way through.
 */
export interface InterruptedAttempt {
    baseSha: string;
    host?: string;
    sessionId?: string;
    spent?: InterruptedSpend;
    depth?: LaneDepth;
    /** How many times losing this tree's host has stopped the stage, which is capped. Unset for none. */
    hostLosses?: number;
}

/**
 * A stage stopped by {@link StageInterrupt} or by losing its host. Says nothing about the card's work,
 * so it must not reach the kickback path, and `CardStageJob` sends the stage again rather than letting
 * it spend a retry.
 */
export class StageInterruptedError extends Error {
    constructor(
        cardId: string,
        stageName: string,
        /** What the run spent before it stopped, so a card's token budget still counts it. */
        readonly usage: AgentRunOutput['usage'],
        readonly attempt: InterruptedAttempt,
        /** Why the stage's host went, when that is what stopped it rather than a shutdown. */
        readonly hostLost?: string,
    ) {
        super(`${cardId} ${stageName} was interrupted by ${hostLost ? `losing its host: ${hostLost}` : 'a daemon shutdown'}`);
        this.name = 'StageInterruptedError';
    }
}

/**
 * A stage stopped because its account hit a usage limit. Handled as an interruption, since it says as
 * little about the card, except that the stage is sent again at `heldUntil`: at once on another
 * account if one is free, and otherwise when the first one resets.
 */
export class StageHeldError extends StageInterruptedError {
    constructor(
        cardId: string,
        stageName: string,
        usage: AgentRunOutput['usage'],
        attempt: InterruptedAttempt,
        readonly limit: UsageLimit,
        readonly heldUntil: number,
    ) {
        super(cardId, stageName, usage, attempt);
        this.message = `${cardId} ${stageName} is held: ${describeUsageLimit(limit)}`;
        this.name = 'StageHeldError';
    }
}
