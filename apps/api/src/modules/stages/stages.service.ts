import { Injectable } from 'injectkit';
import { BoardConfig } from '#modules/board/board.config.js';
import type { BoardColumns } from '../../generated/board.js';
import { loadStages, NON_STAGE_STATES } from './stage.config.js';

/**
 * The board's columns, over stage config — the read surface for `GET /api/stages`.
 *
 * Stage config is a file on the board repo and human-write-only (decision 8), which a browser
 * cannot read and should not be able to write. This exposes the one thing a client needs from it:
 * the names, in order. Nothing else about a stage — its model, budget, prompt or allowed commands —
 * crosses this boundary, because nothing in a UI has any business with them.
 *
 * Read per request rather than cached at boot. `stages.yaml` is edited by hand between cards, and a
 * board still rendering the columns from the last restart is the same class of lie as a daemon
 * serving code from before a fix.
 */
@Injectable()
export class StagesService {
    constructor(private readonly boardConfig: BoardConfig) {}

    async columns(): Promise<BoardColumns> {
        const stages = await loadStages(this.boardConfig.boardRoot);
        return {
            stages: stages.stages.map(stage => stage.name),
            nonStages: [...NON_STAGE_STATES],
        };
    }
}
