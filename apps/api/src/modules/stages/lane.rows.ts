import { parse as parseYaml } from 'yaml';
import { applyRouting, validateStages, type StageRouting } from './stage.config.js';

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
export const lanesFromDocument = (yaml: string, routing: ReadonlyMap<string, StageRouting>, source: string): LaneConfig => {
    const document = applyRouting(parseYaml(yaml), routing);
    const { scopeViolation, alwaysAllowed, deny, sandbox } = validateStages(document, source);
    const { stages } = document as { stages: Record<string, unknown>[] };

    return {
        lanes: stages.map((stage, position) => {
            const { name, mode, worktree, onPass, onFail, adapter, provider, model, instructions, ...settings } = stage;
            return {
                name,
                position,
                mode,
                worktree: worktree ?? 'rw',
                onPass,
                onFail,
                ...(adapter === undefined ? {} : { adapter }),
                ...(provider === undefined ? {} : { provider }),
                ...(model === undefined ? {} : { model }),
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
