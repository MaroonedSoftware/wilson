import type { Card } from '#modules/board/card.js';
import { findStage, StageConfigError, type ProjectStages } from '#modules/stages/stage.config.js';
import { isTerminal } from '#modules/stages/terminal.js';

export interface NotDispatchable {
    reason: string;
}

/**
 * Why the runner cannot dispatch `card`, if it can't.
 *
 * `card move` already refuses a target the stage graph does not name (see `validTargets`); this is
 * the same check turned around to ask whether the runner can actually *run* a card's current stage,
 * which is a narrower question — `manual` and terminal states are valid places for a card to sit but
 * nothing the queue will ever pick up.
 *
 * The `needsHuman` flag is checked first, ahead of terminal and parking-lot, because it can be set on
 * a card sitting in any stage — a card flagged in `implementing` is blocked on a person, not on its
 * stage, and the refusal should say so rather than describing the stage as if that were the problem.
 *
 * Deliberately does not check `Files in scope` against whatever else is currently in flight — card
 * 0104's answer to that lives in `deferOnScopeConflict`
 * (`apps/api/src/modules/jobs/predispatch/scope.conflict.ts`), on the dispatch path every dispatch reaches
 * (poller or `wilson card start`), not here. `BoardRepository.scopeConflict` is the shared matcher
 * both this file's callers and that check are meant to agree with — see the note there before
 * changing either.
 */
export const whyNotDispatchable = (card: Card, stages: ProjectStages): NotDispatchable | undefined => {
    if (card.frontmatter.needsHuman) {
        return { reason: `flagged for a human: ${card.frontmatter.needsHumanReason ?? 'needsHuman is set'}` };
    }

    const stageName = card.frontmatter.stage;

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
