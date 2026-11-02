import { Injectable } from 'injectkit';
import type { AgentRunOutput } from './stage.agent.js';

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

/**
 * Where an interrupted stage left its worktree, carried on the job that sends it again. Plain data,
 * since it travels in the job's payload. `host` is unset for a tree on this machine.
 */
export interface InterruptedAttempt {
    baseSha: string;
    host?: string;
}

/**
 * A stage stopped by {@link StageInterrupt}. Says nothing about the card's work, so it must not reach
 * the kickback path, and `CardStageJob` sends the stage again rather than letting it spend a retry.
 */
export class StageInterruptedError extends Error {
    constructor(
        cardId: string,
        stageName: string,
        /** What the run spent before it stopped, so a card's token budget still counts it. */
        readonly usage: AgentRunOutput['usage'],
        readonly attempt: InterruptedAttempt,
    ) {
        super(`${cardId} ${stageName} was interrupted by a daemon shutdown`);
        this.name = 'StageInterruptedError';
    }
}
