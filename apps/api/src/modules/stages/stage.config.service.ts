import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import type { Lane, LaneRevision, LaneRevisionsQuery, PatchLaneRequest, SetStageRoutingRequest, StageRouting } from '../../generated/stages.js';
import { findStage, StageConfigError, type StageConfig } from './stage.config.js';
import type { Lane as StoredLane } from './lane.rows.js';
import { StageConfigStore } from './stage.config.store.js';

/** The most versions one request returns, and the default — the same numbers `BoardService` uses. */
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 200;

/**
 * The lanes' read and write surface: the service `stages.ck`'s operations bind to, over
 * `StageConfigStore`.
 *
 * Thin on purpose, like `StagesService` beside it: the store already validates on write and keeps the
 * history, so all this adds is the translation of a `StageConfigError` into a 400 or 404 whose
 * `details.reason` is the validator's own sentence, the same way every card mutation on `board.ck`
 * refuses, so `wilson stages set` and `curl` read the same reason.
 */
@Injectable()
export class StageConfigService {
    constructor(private readonly stageConfigs: StageConfigStore) {}

    async routing(): Promise<StageRouting[]> {
        await this.assertHasLanes();
        const { stages } = await this.stageConfigs.load();
        return stages.map(toRouting);
    }

    async setRouting(stage: string, body: SetStageRoutingRequest): Promise<StageRouting> {
        const { adapter, provider, model } = body;
        try {
            const message = body.message?.trim() || `Routed ${stage} to ${model.trim()}`;
            await this.stageConfigs.saveRouting(stage, { adapter, provider, model: model.trim() }, message);
            return toRouting(findStage(await this.stageConfigs.load(), stage));
        } catch (err) {
            throw refusal(err);
        }
    }

    async lanes(): Promise<Lane[]> {
        await this.assertHasLanes();
        return (await this.stageConfigs.lanes()).map(toLaneContract);
    }

    private async assertHasLanes(): Promise<void> {
        if ((await this.stageConfigs.lanes()).length === 0) {
            throw httpError(404).withDetails({ reason: 'this project has no lanes yet; run `wilson board init`' });
        }
    }

    async patchLane(name: string, body: PatchLaneRequest): Promise<Lane> {
        const { message, settings, ...columns } = body;
        if (settings !== undefined && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) {
            throw httpError(400).withDetails({ reason: 'settings must be an object' });
        }
        try {
            const patch = { ...columns, ...(settings === undefined ? {} : { settings: settings as Record<string, unknown> }) };
            return toLaneContract(await this.stageConfigs.patchLane(name, patch, message?.trim() || `Edited ${name}`));
        } catch (err) {
            throw refusal(err);
        }
    }

    async laneRevisions(query: LaneRevisionsQuery): Promise<LaneRevision[]> {
        const limit = Math.min(query.limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
        return (await this.stageConfigs.laneRevisions(query.lane, limit)) as LaneRevision[];
    }
}

/** A `StageConfigError` as the status it means, with the validator's own sentence as the reason. */
const refusal = (err: unknown): unknown => {
    if (!(err instanceof StageConfigError)) return err;
    return httpError(err.kind === 'stage-not-found' ? 404 : 400).withDetails({ reason: err.message });
};

const toRouting = ({ name, mode, adapter, provider, model }: StageConfig): StageRouting => ({ stage: name, mode, adapter, provider, model });

/** The enums here are what `StageConfigSchema` validated on the way in, on every write. */
const toLaneContract = (lane: StoredLane): Lane => lane as Lane;
