import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import type {
    SetStageConfigRequest,
    SetStageRoutingRequest,
    StageConfigDocument,
    StageConfigVersion,
    StageConfigVersionsQuery,
    StageRouting,
} from '../../generated/stages.js';
import { findStage, StageConfigError, type StageConfig } from './stage.config.js';
import { StageConfigStore, type StageConfigDocument as StoredDocument } from './stage.config.store.js';

/** The most versions one request returns, and the default — the same numbers `BoardService` uses. */
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 200;

/** What a save with no message of its own is recorded as. */
const DEFAULT_MESSAGE = 'Edited stage config';

/**
 * The stage config document's read and write surface — the service `stages.ck`'s operations bind
 * to, over `StageConfigStore`.
 *
 * Thin on purpose, like `StagesService` beside it: the store already validates on write and keeps
 * the history, so all this adds is the translation of "no row" into a 404 and of a
 * `StageConfigError` into a 400 whose `details.reason` is the validator's own sentence — the same
 * way every card mutation on `board.ck` refuses, so `wilson stages edit` and `curl` read the same
 * reason.
 */
@Injectable()
export class StageConfigService {
    constructor(private readonly stageConfigs: StageConfigStore) {}

    async get(): Promise<StageConfigDocument> {
        const document = await this.stageConfigs.read();
        if (!document) {
            throw httpError(404).withDetails({
                reason: 'this project has no stage config yet; run `wilson board init` or `wilson stages set <file>`',
            });
        }
        return toContract(document);
    }

    async set(body: SetStageConfigRequest): Promise<StageConfigDocument> {
        try {
            return toContract(await this.stageConfigs.save(body.yaml, body.message?.trim() || DEFAULT_MESSAGE));
        } catch (err) {
            throw refusal(err);
        }
    }

    async routing(): Promise<StageRouting[]> {
        await this.get();
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

    async versions(query: StageConfigVersionsQuery): Promise<StageConfigVersion[]> {
        const limit = Math.min(query.limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
        const versions = await this.stageConfigs.versions(limit);
        return versions.map(version => ({ id: version.id, message: version.message, createdAt: version.createdAt }));
    }
}

/** A `StageConfigError` as the status it means, with the validator's own sentence as the reason. */
const refusal = (err: unknown): unknown => {
    if (!(err instanceof StageConfigError)) return err;
    return httpError(err.kind === 'stage-not-found' ? 404 : 400).withDetails({ reason: err.message });
};

const toRouting = ({ name, mode, adapter, provider, model }: StageConfig): StageRouting => ({ stage: name, mode, adapter, provider, model });

const toContract = (document: StoredDocument): StageConfigDocument => ({
    id: document.id,
    yaml: document.yaml,
    message: document.message,
    createdAt: document.createdAt,
});
