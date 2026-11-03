import { DateTime } from 'luxon';
import type { JsonValue } from '../sdk-options.js';

const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * One stored document. `yaml` is the text verbatim, comments included — the document is the config,
 * not a rendering of columns. `message` is what the commit message on `stages.yaml` used to be.
 * generated from [StageConfigDocument](../../../../apps/api/data/contracts/stages.ck)
 */
export interface StageConfigDocument {
    id: string;
    yaml: string;
    message: string;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a StageConfigDocument into its runtime type. Mutates and returns `raw`. */
export function reviveStageConfigDocument(raw: StageConfigDocument): StageConfigDocument {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'StageConfigDocument.createdAt');
    return raw;
}

/**
 * `message` optional: `wilson stages edit` has no commit-message prompt the way `git commit` does,
 * and a default ("Edited stage config") beats forcing one. Supply it when the change is worth a
 * sentence — "Raise the review step budget to 150" is what the history is for.
 * generated from [SetStageConfigRequest](../../../../apps/api/data/contracts/stages.ck)
 */
export interface SetStageConfigRequest {
    yaml: string;
    message?: string;
}

/**
 * generated from [StageConfigVersion](../../../../apps/api/data/contracts/stages.ck)
 */
export interface StageConfigVersion {
    id: string;
    message: string;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a StageConfigVersion into its runtime type. Mutates and returns `raw`. */
export function reviveStageConfigVersion(raw: StageConfigVersion): StageConfigVersion {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'StageConfigVersion.createdAt');
    return raw;
}

/**
 * Same shape as board.ck's `ListQuery`, declared here rather than shared: a contract file is the
 * unit contractkit generates from, and a cross-file reference is not worth a coupling for one
 * optional field.
 * generated from [StageConfigVersionsQuery](../../../../apps/api/data/contracts/stages.ck)
 */
export interface StageConfigVersionsQuery {
    limit?: number;
}

/**
 * Which engine, provider and model a stage runs on, as it would dispatch now. `mode` is here so a
 * client can tell the stages that reach a model from the manual ones that never do, which have no
 * `model`.
 * generated from [StageRouting](../../../../apps/api/data/contracts/stages.ck)
 */
export interface StageRouting {
    stage: string;
    mode: 'agent' | 'command' | 'manual';
    adapter: 'api' | 'cli' | 'codex';
    provider: 'anthropic' | 'openai' | 'xai';
    model?: string;
}

/**
 * generated from [SetStageRoutingRequest](../../../../apps/api/data/contracts/stages.ck)
 */
export interface SetStageRoutingRequest {
    adapter: 'api' | 'cli' | 'codex';
    provider: 'anthropic' | 'openai' | 'xai';
    model: string;
    message?: string;
}

/**
 * One lane, as `wilson.lanes` holds it. `settings` is everything else a stage can say (budgets,
 * commands, placement), holding only what someone chose, so a default stays a default.
 * generated from [Lane](../../../../apps/api/data/contracts/stages.ck)
 */
export interface Lane {
    name: string;
    position: number;
    mode: 'agent' | 'command' | 'manual';
    worktree: 'none' | 'readonly' | 'rw';
    onPass: string;
    onFail: string;
    adapter?: 'api' | 'cli' | 'codex';
    provider?: 'anthropic' | 'openai' | 'xai';
    model?: string;
    instructions: string;
    settings: JsonValue;
}

/**
 * Only what changes. A key in `settings` is set, or removed when its value is null. Routing has its own
 * operation below, which checks it against what the lane's engine can run.
 * generated from [PatchLaneRequest](../../../../apps/api/data/contracts/stages.ck)
 */
export interface PatchLaneRequest {
    mode?: 'agent' | 'command' | 'manual';
    worktree?: 'none' | 'readonly' | 'rw';
    onPass?: string;
    onFail?: string;
    instructions?: string;
    settings?: JsonValue;
    message?: string;
}

/**
 * One change to a lane or, with no `lane`, to what a project's lanes share. No `snapshot` means the
 * lane was removed.
 * generated from [LaneRevision](../../../../apps/api/data/contracts/stages.ck)
 */
export interface LaneRevision {
    id: string;
    lane?: string;
    snapshot?: JsonValue;
    message: string;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a LaneRevision into its runtime type. Mutates and returns `raw`. */
export function reviveLaneRevision(raw: LaneRevision): LaneRevision {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'LaneRevision.createdAt');
    return raw;
}

/**
 * generated from [LaneRevisionsQuery](../../../../apps/api/data/contracts/stages.ck)
 */
export interface LaneRevisionsQuery {
    lane?: string;
    limit?: number;
}
