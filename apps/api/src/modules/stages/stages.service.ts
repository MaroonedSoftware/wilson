import { Injectable } from 'injectkit';
import type { BoardColumns } from '../../generated/board.js';
import { NON_STAGE_STATES } from './stage.config.js';
import { StageConfigStore } from './stage.config.store.js';

/**
 * The board's columns, over stage config — the read surface for `GET /api/stages`.
 *
 * Stage config is human-write-only (decision 8), and a browser has no business with most of it.
 * This exposes the one thing a board client needs from it: the names, in order. Nothing else about
 * a stage — its model, budget, prompt or allowed commands — crosses this boundary, because nothing
 * in a UI has any business with them. The document itself has its own surface for the operator.
 *
 * Read per request rather than cached at boot. The config is edited between cards, and a board
 * still rendering the columns from the last restart is the same class of lie as a daemon serving
 * code from before a fix.
 */
@Injectable()
export class StagesService {
    constructor(private readonly stageConfigs: StageConfigStore) {}

    async columns(): Promise<BoardColumns> {
        const stages = await this.stageConfigs.load();
        return {
            stages: stages.stages.map(stage => stage.name),
            nonStages: [...NON_STAGE_STATES],
        };
    }
}
