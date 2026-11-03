import { Injectable } from 'injectkit';
import { Kysely, type Selectable, type Transaction } from 'kysely';
import { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';
import { isDeepStrictEqual } from 'node:util';
import {
    assertRoutable,
    findStage,
    parseStages,
    runsModel,
    StageConfigError,
    validateStages,
    type ProjectStages,
    type StageRouting,
} from './stage.config.js';
import {
    documentFromLanes,
    lanesFromDocument,
    patchLane,
    type Lane,
    type LaneConfig,
    type LanePatch,
    type LaneRevision,
    type ProjectLaneSettings,
} from './lane.rows.js';

/**
 * Where a project's lanes come from.
 *
 * Every dispatch, poller tick and several API routes read config through `load`, which answers with a
 * validated, frozen `ProjectStages`. The rows are `wilson.lanes` and `wilson.project_lane_settings`,
 * and every change adds to `wilson.lane_revisions`.
 *
 * Abstract for the same reason `BoardRepository` and `BoardConfig` are: production wires the Postgres
 * implementation below through DI, and a test that only needs "some config" constructs
 * `StaticStageConfigStore` with YAML rather than seeding rows.
 */
@Injectable()
export abstract class StageConfigStore {
    /**
     * The current project's config, validated. Throws `StageConfigError('config-invalid')` when it has
     * none or its rows no longer validate: either way a fact about the config rather than about any
     * one card, so a dispatch that hits it defers (see `StageConfigErrorKind`).
     */
    abstract load(): Promise<ProjectStages>;

    /**
     * Set one lane's routing. Refused with `StageConfigError` when there is no such lane, it runs no
     * model, or `assertRoutable` turns the routing down.
     */
    abstract saveRouting(stage: string, routing: StageRouting, message: string): Promise<void>;

    /**
     * Fill the project's lane tables from a stage config document left in `wilson.stage_configs`, when
     * that document is newer than what they hold. Does nothing otherwise, so it is safe on every start.
     * Throws `StageConfigError` for a document that does not validate, and writes nothing.
     */
    abstract importLanes(): Promise<void>;

    /** Give a project with no lanes its first ones. Validated first, and nothing is written if refused. */
    abstract seedLanes(config: LaneConfig, message: string): Promise<void>;

    /** The current project's lanes, in board order. Empty when it has none. */
    abstract lanes(): Promise<Lane[]>;

    /**
     * Change one lane. Refused with `StageConfigError` when there is no such lane or the result would
     * not load, and nothing is written. Records a revision when anything changed.
     */
    abstract patchLane(name: string, patch: LanePatch, message: string): Promise<Lane>;

    /** The current project's lane changes, newest first, for one lane when `lane` names it. */
    abstract laneRevisions(lane: string | undefined, limit: number): Promise<LaneRevision[]>;
}

/**
 * The last validated config per project, with the revision it was built from.
 *
 * `load` runs on every dispatch twice over, on every poller tick and from several API routes, for rows
 * that change only when a person changes them. Every change adds a revision, so "the newest id is the
 * one I built from" is exactly "nothing has changed", and one cheap `SELECT` replaces rebuilding it.
 *
 * Only successful builds are stored: an invalid config must keep throwing on every call, since the
 * operator fixing it is exactly the case that needs the next call to see the fix.
 */
const parsedByProject = new Map<string, { id: string; value: ProjectStages }>();

/**
 * The lane tables, in Postgres.
 *
 * Keyed by `BoardConfig.project` the way `SettingsStore` and `PostgresBoardRepository` are, read
 * fresh on every call, so under `runAsProject` (project.context.ts) the same instance answers for
 * whichever project's work is on the call stack, with nothing here knowing several exist.
 */
@Injectable()
export class PostgresStageConfigStore extends StageConfigStore {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {
        super();
    }

    async load(): Promise<ProjectStages> {
        const project = this.config.project;
        const newest = await this.db
            .selectFrom('wilson.laneRevisions')
            .select('id')
            .where('project', '=', project)
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();
        if (!newest) {
            throw new StageConfigError('config-invalid', `project "${project}" has no stage config; run \`wilson board init\``);
        }

        const id = String(newest.id);
        const cached = parsedByProject.get(project);
        if (cached && cached.id === id) return cached.value;

        const [lanes, settings] = await Promise.all([
            this.db.selectFrom('wilson.lanes').selectAll().where('project', '=', project).execute(),
            this.db.selectFrom('wilson.projectLaneSettings').selectAll().where('project', '=', project).executeTakeFirstOrThrow(),
        ]);
        const value = validateStages(
            documentFromLanes({ lanes: lanes.map(toLane), project: toProjectSettings(settings) }),
            `the lanes of project "${project}"`,
        );
        parsedByProject.set(project, { id, value });
        return value;
    }

    async importLanes(): Promise<void> {
        const document = await this.db
            .selectFrom('wilson.stageConfigs')
            .select(['id', 'yaml'])
            .where('project', '=', this.config.project)
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();
        if (!document) return;

        const id = BigInt(document.id);
        const imported = await this.db
            .selectFrom('wilson.projectLaneSettings')
            .select('importedConfigId')
            .where('project', '=', this.config.project)
            .executeTakeFirst();
        if (imported && BigInt(imported.importedConfigId) >= id) return;

        const config = lanesFromDocument(document.yaml, routingByStage(await this.currentRouting()), `stage config ${id}`);
        await this.db.transaction().execute(trx => this.writeLanes(trx, config, id, `Imported from stage config ${id}`));
    }

    async seedLanes(config: LaneConfig, message: string): Promise<void> {
        validateStages(documentFromLanes(config), 'the lanes being seeded');
        await this.db.transaction().execute(trx => this.writeLanes(trx, config, 0n, message));
    }

    async lanes(): Promise<Lane[]> {
        const rows = await this.db.selectFrom('wilson.lanes').selectAll().where('project', '=', this.config.project).orderBy('position').execute();
        return rows.map(toLane);
    }

    async patchLane(name: string, patch: LanePatch, message: string): Promise<Lane> {
        return this.db.transaction().execute(async trx => {
            const project = this.config.project;
            const lanes = await trx.selectFrom('wilson.lanes').selectAll().where('project', '=', project).forUpdate().execute();
            const settings = await trx.selectFrom('wilson.projectLaneSettings').selectAll().where('project', '=', project).executeTakeFirst();
            if (!settings) throw new StageConfigError('stage-not-found', `project "${project}" has no lanes`);

            const next = patchLane(
                { lanes: lanes.map(toLane), project: toProjectSettings(settings) },
                name,
                patch,
                `lane "${name}" of project "${project}"`,
            );
            await this.writeLanes(trx, next, BigInt(settings.importedConfigId), message);
            return next.lanes.find(lane => lane.name === name)!;
        });
    }

    async laneRevisions(lane: string | undefined, limit: number): Promise<LaneRevision[]> {
        let query = this.db.selectFrom('wilson.laneRevisions').selectAll().where('project', '=', this.config.project);
        if (lane !== undefined) query = query.where('lane', '=', lane);
        const rows = await query.orderBy('id', 'desc').limit(limit).execute();
        return rows.map(row => ({
            id: String(row.id),
            ...(row.lane == null ? {} : { lane: row.lane }),
            ...(row.snapshot == null ? {} : { snapshot: row.snapshot }),
            message: row.message,
            createdAt: row.createdAt,
        }));
    }

    /** Make the lane tables say `config`, recording a revision for each thing that changed and nothing else. */
    private async writeLanes(trx: Transaction<DB>, config: LaneConfig, configId: bigint, message: string): Promise<void> {
        const project = this.config.project;
        const current = await trx.selectFrom('wilson.lanes').selectAll().where('project', '=', project).execute();
        const before = new Map(current.map(row => [row.name, toLane(row)]));
        const revisions: { lane: string | null; snapshot: string | null }[] = [];

        for (const lane of config.lanes) {
            const previous = before.get(lane.name);
            before.delete(lane.name);
            if (previous && isDeepStrictEqual(previous, lane)) continue;

            const values = {
                position: lane.position,
                mode: lane.mode,
                worktree: lane.worktree,
                onPass: lane.onPass,
                onFail: lane.onFail,
                adapter: lane.adapter ?? null,
                provider: lane.provider ?? null,
                model: lane.model ?? null,
                instructions: lane.instructions,
                settings: JSON.stringify(lane.settings),
            };
            await trx
                .insertInto('wilson.lanes')
                .values({ project, name: lane.name, ...values })
                .onConflict(oc => oc.columns(['project', 'name']).doUpdateSet({ ...values, updatedAt: DateTime.now() }))
                .execute();
            revisions.push({ lane: lane.name, snapshot: JSON.stringify(lane) });
        }

        for (const name of before.keys()) {
            await trx.deleteFrom('wilson.lanes').where('project', '=', project).where('name', '=', name).execute();
            revisions.push({ lane: name, snapshot: null });
        }

        const settings = await trx.selectFrom('wilson.projectLaneSettings').selectAll().where('project', '=', project).executeTakeFirst();
        if (!settings || !isDeepStrictEqual(toProjectSettings(settings), config.project)) {
            revisions.push({ lane: null, snapshot: JSON.stringify(config.project) });
        }
        const values = {
            scopeViolation: config.project.scopeViolation,
            alwaysAllowed: [...config.project.alwaysAllowed],
            deny: [...config.project.deny],
            sandbox: JSON.stringify(config.project.sandbox),
            importedConfigId: configId,
        };
        await trx
            .insertInto('wilson.projectLaneSettings')
            .values({ project, ...values })
            .onConflict(oc => oc.column('project').doUpdateSet({ ...values, updatedAt: DateTime.now() }))
            .execute();

        if (revisions.length > 0) {
            await trx
                .insertInto('wilson.laneRevisions')
                .values(revisions.map(revision => ({ project, ...revision, message })))
                .execute();
        }
    }

    async saveRouting(stage: string, routing: StageRouting, message: string): Promise<void> {
        const { isolated, mode } = findStage(await this.load(), stage);
        if (!runsModel({ name: stage, mode })) throw new StageConfigError('config-invalid', `${stage} runs no model, so it has no routing to set`);
        assertRoutable(stage, routing, isolated);

        const project = this.config.project;
        await this.db.transaction().execute(async trx => {
            const lane = await trx
                .updateTable('wilson.lanes')
                .set({ ...routing, updatedAt: DateTime.now() })
                .where('project', '=', project)
                .where('name', '=', stage)
                .returningAll()
                .executeTakeFirstOrThrow();
            await trx
                .insertInto('wilson.laneRevisions')
                .values({ project, lane: stage, snapshot: JSON.stringify(toLane(lane)), message })
                .execute();
        });
    }

    /** The newest `wilson.stage_routing` row for each stage, which only an import still has a use for. */
    private currentRouting() {
        return this.db
            .selectFrom('wilson.stageRouting')
            .distinctOn('stage')
            .select(['stage', 'adapter', 'provider', 'model'])
            .where('project', '=', this.config.project)
            .orderBy('stage')
            .orderBy('id', 'desc')
            .execute();
    }
}

const toLane = (row: Selectable<DB['wilson.lanes']>): Lane => ({
    name: row.name,
    position: row.position,
    mode: row.mode,
    worktree: row.worktree,
    onPass: row.onPass,
    onFail: row.onFail,
    ...(row.adapter == null ? {} : { adapter: row.adapter }),
    ...(row.provider == null ? {} : { provider: row.provider }),
    ...(row.model == null ? {} : { model: row.model }),
    instructions: row.instructions,
    settings: row.settings as Lane['settings'],
});

const toProjectSettings = (row: Selectable<DB['wilson.projectLaneSettings']>): ProjectLaneSettings => ({
    scopeViolation: row.scopeViolation,
    alwaysAllowed: row.alwaysAllowed,
    deny: row.deny,
    sandbox: row.sandbox as unknown as ProjectLaneSettings['sandbox'],
});

const routingByStage = (rows: { stage: string; adapter: string; provider: string; model: string }[]) =>
    new Map(rows.map(({ stage, adapter, provider, model }) => [stage, { adapter, provider, model } as StageRouting]));

/**
 * An in-memory store holding one project's config, for tests: the counterpart of `StaticBoardConfig`.
 * Construct it with the YAML a test wants `load` to answer with, and `save` swaps it for another.
 */
export class StaticStageConfigStore extends StageConfigStore {
    private current?: string;
    private readonly routing = new Map<string, StageRouting>();
    private readonly revisions: LaneRevision[] = [];

    constructor(yaml?: string) {
        super();
        this.current = yaml;
    }

    async load(): Promise<ProjectStages> {
        if (this.current === undefined) throw new StageConfigError('config-invalid', 'no stage config');
        return parseStages(this.current, 'stage config', this.routing);
    }

    /** Swap the config for another, refused as `load` would refuse it. */
    async save(yaml: string): Promise<void> {
        parseStages(yaml, 'the submitted stage config', this.routing);
        this.current = yaml;
    }

    async saveRouting(stage: string, routing: StageRouting): Promise<void> {
        const { isolated, mode } = findStage(await this.load(), stage);
        if (!runsModel({ name: stage, mode })) throw new StageConfigError('config-invalid', `${stage} runs no model, so it has no routing to set`);
        assertRoutable(stage, routing, isolated);
        this.routing.set(stage, routing);
    }

    async importLanes(): Promise<void> {}

    async seedLanes(config: LaneConfig): Promise<void> {
        validateStages(documentFromLanes(config), 'the lanes being seeded');
        this.current = JSON.stringify(documentFromLanes(config));
    }

    private config(): LaneConfig | undefined {
        return this.current === undefined ? undefined : lanesFromDocument(this.current, this.routing, 'stage config');
    }

    async lanes(): Promise<Lane[]> {
        return this.config()?.lanes ?? [];
    }

    async patchLane(name: string, patch: LanePatch, message: string): Promise<Lane> {
        const config = this.config();
        if (!config) throw new StageConfigError('stage-not-found', 'no stage config');
        const next = patchLane(config, name, patch, `lane "${name}"`);
        this.current = JSON.stringify(documentFromLanes(next));
        this.revisions.unshift({ id: String(this.revisions.length + 1), lane: name, message, createdAt: DateTime.now() });
        return next.lanes.find(lane => lane.name === name)!;
    }

    async laneRevisions(lane: string | undefined, limit: number): Promise<LaneRevision[]> {
        return this.revisions.filter(revision => lane === undefined || revision.lane === lane).slice(0, limit);
    }
}
