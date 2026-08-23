import { NON_STAGE_STATES, type ProjectStages } from '#modules/stages/stage.config.js';

export interface ChainDecision {
    /** Whether `target` should be enqueued as the card's next stage. */
    continue: boolean;
    /** Why the chain stops here. Present only when `continue` is false. */
    reason?: string;
}

/**
 * Whether a card that just transitioned to `target` should be re-enqueued.
 *
 * Kept pure and separate from `CardStageJob` on purpose: the dispatcher only ever reports where a
 * card landed, never whether the queue should keep going, and this is the one place that turns
 * "landed here" into "keep going" or "stop" — a decision worth testing without a live pg-boss.
 */
export const decideChain = (target: string, stages: ProjectStages): ChainDecision => {
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
