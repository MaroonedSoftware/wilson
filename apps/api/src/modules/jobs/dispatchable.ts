import { findStage, StageConfigError, type ProjectStages } from '#modules/stages/stage.config.js';
import { isTerminal } from '#modules/stages/terminal.js';

export interface NotDispatchable {
    reason: string;
}

/**
 * Why the runner cannot dispatch a card sitting in `stageName`, if it can't.
 *
 * `card move` already refuses a target the stage graph does not name (see `validTargets`); this is
 * the same check turned around to ask whether the runner can actually *run* a card's current stage,
 * which is a narrower question — `manual` and terminal states are valid places for a card to sit but
 * nothing the queue will ever pick up.
 */
export const whyNotDispatchable = (stageName: string, stages: ProjectStages): NotDispatchable | undefined => {
    if (isTerminal(stageName)) {
        return { reason: `"${stageName}" is a terminal state — the card is finished.` };
    }

    if (stageName === 'parking-lot') {
        return { reason: 'the card is parked — promote it to a stage before enqueuing it.' };
    }

    let stage;
    try {
        stage = findStage(stages, stageName);
    } catch (error) {
        if (error instanceof StageConfigError) {
            return { reason: `${error.message}` };
        }
        throw error;
    }

    if (stage.mode !== 'agent') {
        return { reason: `"${stageName}" is a ${stage.mode} stage — the runner does not dispatch it.` };
    }

    return undefined;
};
