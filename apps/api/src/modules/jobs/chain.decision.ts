import { NON_STAGE_STATES, type ProjectStages } from '#modules/stages/stage.config.js';

export interface ChainDecision {
    /** Whether `target` should be enqueued as the card's next stage. */
    continue: boolean;
    /** Why the chain stops here. Present only when `continue` is false. */
    reason?: string;
}

export interface DecideChainOptions {
    /** Whether the card was flagged for a human on the transition that produced `target`. */
    needsHuman?: boolean;
}

/**
 * Whether a card that just transitioned to `target` should be re-enqueued.
 *
 * Kept pure and separate from `CardStageJob` on purpose: the dispatcher only ever reports where a
 * card landed, never whether the queue should keep going, and this is the one place that turns
 * "landed here" into "keep going" or "stop" — a decision worth testing without a live pg-boss.
 *
 * `needsHuman` is checked before every other rule, including before `target` is looked up as a
 * configured stage. Once a later card lets an exhausted stage leave a card in place instead of
 * routing it to `needs-human`, `target` will be that same configured agent stage the card was
 * already failing in — so without this check first, the chain would re-enqueue it, the stage would
 * exhaust its retries again, and the loop would repeat forever: a fresh worktree and a `pnpm install`
 * on every pass, spending real money for a card no amount of retrying will fix. Checking the flag
 * first turns that spend loop into a stop, unconditionally, before anything else gets a vote.
 */
export const decideChain = (target: string, stages: ProjectStages, options: DecideChainOptions = {}): ChainDecision => {
    if (options.needsHuman) {
        return { continue: false, reason: 'the card is flagged for a human' };
    }

    if ((NON_STAGE_STATES as readonly string[]).includes(target)) {
        return { continue: false, reason: `${target} is a terminal state` };
    }

    const stage = stages.stages.find(s => s.name === target);
    if (!stage) {
        return { continue: false, reason: `${target} is not a configured stage` };
    }

    if (stage.mode !== 'agent') {
        return { continue: false, reason: `${target} is a "${stage.mode}" stage, which needs a human or a command runner, not the queue` };
    }

    return { continue: true };
};
