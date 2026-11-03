import type { DateTime } from 'luxon';
import { parse as parseYaml } from 'yaml';
import { DONE } from './terminal.js';
import { applyRouting, assertRoutable, runsModel, StageConfigError, validateStages, type StageRouting } from './stage.config.js';

/** One `wilson.lanes` row, as the store reads and writes it. */
export interface Lane {
    name: string;
    position: number;
    mode: string;
    worktree: string;
    onPass: string;
    onFail: string;
    adapter?: string;
    provider?: string;
    model?: string;
    instructions: string;
    /** Everything else a stage can say, exactly as it was written, so a schema default stays a default. */
    settings: Record<string, unknown>;
}

/** One `wilson.project_lane_settings` row, less the bookkeeping. */
export interface ProjectLaneSettings {
    scopeViolation: string;
    alwaysAllowed: readonly string[];
    deny: readonly string[];
    sandbox: { enabled: boolean; allowedDomains: readonly string[] };
}

/** What can change about a lane on its own. A key in `settings` set to null is removed. */
export interface LanePatch {
    mode?: string;
    worktree?: string;
    onPass?: string;
    onFail?: string;
    instructions?: string;
    settings?: Record<string, unknown>;
}

/** One `wilson.lane_revisions` row. No `lane` is a project-wide change, no `snapshot` a removed lane. */
export interface LaneRevision {
    id: string;
    lane?: string;
    snapshot?: unknown;
    message: string;
    createdAt: DateTime;
}

export interface LaneConfig {
    lanes: Lane[];
    project: ProjectLaneSettings;
}

/**
 * Split a stage config document into lane rows. Refused with `StageConfigError` when `parseStages`
 * would refuse it, so nothing unloadable reaches the tables.
 *
 * Read from the document rather than from the validated result, whose defaults would otherwise be
 * stored as though someone had chosen them. Text outside a stage, comments included, has no column:
 * it stays in `wilson.stage_configs`.
 */
export const lanesFromDocument = (yaml: string, routing: ReadonlyMap<string, StageRouting>, source: string): LaneConfig =>
    lanesFromRaw(applyRouting(parseYaml(yaml), routing), source);

type RawStage = Record<string, unknown>;

/**
 * `challenge` as a step of `review` rather than a lane of its own. Its instructions, budgets and
 * commands move over as they are; its routing does not, because a step runs on its lane's. A project
 * with no `review` lane keeps it as it is.
 */
const foldChallenge = (stages: RawStage[]): RawStage[] => {
    const challenge = stages.find(stage => stage.name === 'challenge');
    if (!challenge || !stages.some(stage => stage.name === 'review')) return stages;

    const { name: _name, onPass, onFail, adapter: _adapter, provider: _provider, model: _model, maxKickbacks: _maxKickbacks, ...fields } = challenge;
    return stages
        .filter(stage => stage !== challenge)
        .map(stage => {
            if (stage.name !== 'review') {
                return {
                    ...stage,
                    onPass: stage.onPass === 'challenge' ? 'review' : stage.onPass,
                    onFail: stage.onFail === 'challenge' ? 'review' : stage.onFail,
                };
            }
            return {
                ...stage,
                onPass: stage.onPass === 'challenge' ? onPass : stage.onPass,
                onFail: stage.onFail === 'challenge' ? onFail : stage.onFail,
                steps: [...((stage.steps as RawStage[] | undefined) ?? []), { name: 'challenge', on: 'revise', ...fields }],
            };
        });
};

/** Lanes that used to be stages of their own, each with the lane a card sitting in one moves to. */
export const FOLDED_LANES: Readonly<Record<string, string>> = { challenge: 'review' };

/** The rows for an already-read config, with old shapes brought up to date first. */
export const lanesFromRaw = (raw: unknown, source: string): LaneConfig => {
    const stages = foldChallenge((raw as { stages: RawStage[] }).stages);
    const document = { ...(raw as object), stages };
    const { scopeViolation, alwaysAllowed, deny, sandbox } = validateStages(document, source);

    return {
        lanes: stages.map((stage, position) => {
            const { name, mode, worktree, onPass, onFail, adapter, provider, model, instructions, ...settings } = stage;
            // A manual lane's routing was only ever there because the schema once demanded a model.
            const routed = runsModel(stage as { name: string; mode: string });
            return {
                name,
                position,
                mode,
                worktree: worktree ?? 'rw',
                onPass: onPass === 'merged' ? DONE : onPass,
                onFail: onFail === 'merged' ? DONE : onFail,
                ...(routed && adapter !== undefined ? { adapter } : {}),
                ...(routed && provider !== undefined ? { provider } : {}),
                ...(routed && model !== undefined ? { model } : {}),
                instructions,
                settings,
            } as Lane;
        }),
        project: { scopeViolation, alwaysAllowed, deny, sandbox },
    };
};

/** The document `validateStages` expects, from lane rows, in lane order. */
export const documentFromLanes = ({ lanes, project }: LaneConfig): unknown => ({
    ...project,
    stages: [...lanes].sort((a, b) => a.position - b.position).map(({ position: _position, settings, ...columns }) => ({ ...settings, ...columns })),
});

/** Keys with a column or an operation of their own, which `settings` would otherwise silently lose to. */
const NOT_SETTINGS = ['name', 'position', 'mode', 'worktree', 'onPass', 'onFail', 'adapter', 'provider', 'model', 'instructions'];

/**
 * `config` with one lane changed, validated as a whole, because a lane's route can name another lane.
 * Refused with `StageConfigError`: `stage-not-found` for no such lane, `config-invalid` otherwise.
 */
export const patchLane = (config: LaneConfig, name: string, patch: LanePatch, source: string): LaneConfig => {
    const lane = config.lanes.find(candidate => candidate.name === name);
    if (!lane) {
        throw new StageConfigError('stage-not-found', `no lane named "${name}" (have: ${config.lanes.map(({ name }) => name).join(', ')})`);
    }

    const { settings: settingsPatch = {}, ...columns } = patch;
    const reserved = Object.keys(settingsPatch).filter(key => NOT_SETTINGS.includes(key));
    if (reserved.length > 0) {
        throw new StageConfigError('config-invalid', `${reserved.join(', ')} cannot be set as settings; each has its own field or operation`);
    }
    const settings = { ...lane.settings, ...settingsPatch };
    for (const [key, value] of Object.entries(settingsPatch)) {
        if (value === null) delete settings[key];
    }

    const patched = { ...lane, ...columns, settings };
    const next = { ...config, lanes: config.lanes.map(candidate => (candidate === lane ? patched : candidate)) };
    const { stages } = validateStages(documentFromLanes(next), source);
    const { adapter, provider, model, isolated } = stages.find(stage => stage.name === name)!;
    if (model) assertRoutable(name, { adapter, provider, model }, isolated);
    return next;
};
