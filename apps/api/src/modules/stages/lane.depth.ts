import type { Diffstat } from '#modules/worktree/worktree.manager.js';
import type { LaneDepth, StageConfig } from './stage.config.js';

/** Whether a card's diff could change how this run is configured. A step always runs on its lane's model. */
export const scalesWithDiff = (stage: StageConfig): boolean => !stage.step && (stage.depths?.length ?? 0) > 0;

/** `stage` on `depth`, as a copy, since a loaded config is frozen. Anything `depth` does not name stays. */
export const atDepth = (stage: StageConfig, depth: LaneDepth): StageConfig => ({
    ...stage,
    ...(depth.model !== undefined && { model: depth.model }),
    ...(depth.maxSteps !== undefined && { maxSteps: depth.maxSteps }),
    ...(depth.maxInputTokens !== undefined && { maxInputTokens: depth.maxInputTokens }),
    depth,
});

/**
 * The stage a card's diff calls for: on the highest of the lane's `depths` the diff reaches. A diff
 * below them all, or one that could not be measured, runs the lane as written.
 */
export const withDepth = (stage: StageConfig, diffstat: Diffstat | undefined): StageConfig => {
    if (!diffstat || !scalesWithDiff(stage)) return stage;
    const changedLines = diffstat.added + diffstat.removed;
    const depth = stage.depths?.filter(({ minChangedLines }) => minChangedLines <= changedLines).at(-1);
    return depth ? atDepth(stage, depth) : stage;
};
