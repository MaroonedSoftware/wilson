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
    splitRouting,
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

/** One stored stage config document — a `wilson.stage_configs` row, as a caller sees it. */
export interface StageConfigDocument {
    id: string;
    yaml: string;
    message: string;
    createdAt: DateTime;
}

/** One row of a project's stage config history — what `git log` on `stages.yaml` used to answer. */
export interface StageConfigVersionSummary {
    id: string;
    message: string;
    createdAt: DateTime;
}

/**
 * Where a project's stage config comes from.
 *
 * Stage config used to be `config/stages.yaml` in the sibling board repo, read by a free function
 * (`loadStages(boardRoot)`) from every dispatch, every poller tick and several API routes. It is a
 * `wilson.stage_configs` row now — the last piece of board state to move off disk after the cards
 * did (PROJECT.md decision 1) — and this is the seam every one of those callers reads it through.
 *
 * Abstract for the same reason `BoardRepository` and `BoardConfig` are: production wires the
 * Postgres implementation below through DI, and a test that only needs "some config" constructs
 * `StaticStageConfigStore` with a string rather than seeding a database row.
 *
 * `load` is the hot path and answers with a parsed, validated, frozen `ProjectStages`. `read`,
 * `save` and `versions` are the edit surface — `wilson stages show|edit|set|versions` and
 * `wilson board init` — and deal in the document itself.
 */
@Injectable()
export abstract class StageConfigStore {
    /**
     * The current project's config, parsed and validated. Throws `StageConfigError('config-invalid')`
     * when the project has no config at all or the stored document does not validate — either way a
     * fact about the config rather than about any one card, so a dispatch that hits it defers (see
     * `StageConfigErrorKind`).
     */
    abstract load(): Promise<ProjectStages>;

    /** The current project's stored document, or undefined when it has none yet. */
    abstract read(): Promise<StageConfigDocument | undefined>;

    /**
     * Store a new document as the current project's config. Validated first and refused with
     * `StageConfigError('config-invalid')` — nothing is written for a document `load` could not
     * later read. Every save is a new row: the previous document stays in the history.
     *
     * Routing fields in the document move to `wilson.stage_routing` (`splitRouting`) and are stored
     * without them, so what comes back from `read` may not be the text submitted. A stage with neither
     * those fields nor a routing row is refused, as a document missing `model` always was.
     */
    abstract save(yaml: string, message: string): Promise<StageConfigDocument>;

    /** The current project's config history, newest first. */
    abstract versions(limit?: number): Promise<StageConfigVersionSummary[]>;

    /**
     * Route one stage. Refused with `StageConfigError` when the current config has no such stage or
     * the routing is one `assertRoutable` turns down. Every change is a new row, like `save`.
     */
    abstract saveRouting(stage: string, routing: StageRouting, message: string): Promise<void>;

    /**
     * Move any routing left in the stored document to `wilson.stage_routing`, once, for a document
     * from before that table. A stage that already has a row keeps it. Does nothing when there is no
     * document or it holds no routing, so it is safe on every start.
     */
    abstract moveStoredRouting(): Promise<void>;

    /**
     * Fill the project's lane tables from its stored document, when that document is newer than what
     * they hold. Does nothing when there is no document or the tables are current, so it is safe on
     * every start. Throws `StageConfigError` for a document that does not validate, and writes nothing.
     */
    abstract importLanes(): Promise<void>;

    /** The current project's lanes, in board order. Empty when it has no config at all. */
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
 * The last successfully parsed config per project, with the row ids it was parsed from.
 *
 * `load` runs on every dispatch twice over (`StageDispatcher.run` and `CardStageJob.runStage`), on
 * every poller tick and from several API routes, and a parse is a YAML parse, a zod validation and a
 * route check of a document that changes only when a person saves it. The ids are the cache key:
 * every save is a new row with a higher id, on `wilson.stage_configs` and `wilson.stage_routing`
 * alike, so "the newest ids are the ones I parsed" is exactly "nothing has changed". Two cheap
 * `SELECT`s per call replace the `stat` the file cache used, and the frozen object is shared across
 * callers the same way.
 *
 * Only successful parses are stored: an invalid document must keep throwing on every call, since the
 * operator fixing it is exactly the case that needs the next call to see the fix.
 */
const parsedByProject = new Map<string, { id: string; value: ProjectStages }>();

/**
 * `wilson.stage_configs`, in Postgres.
 *
 * Keyed by `BoardConfig.project` the way `SettingsStore` and `PostgresBoardRepository` are, read
 * fresh on every call — so under `runAsProject` (project.context.ts) the same instance answers for
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
        const row = await this.newest().select(['id', 'yaml']).executeTakeFirst();
        const imported = await this.importedConfigId();
        if (imported !== undefined && (!row || imported >= BigInt(row.id))) return this.loadLanes();

        if (!row) {
            throw new StageConfigError(
                'config-invalid',
                `project "${project}" has no stage config; run \`wilson board init\` or \`wilson stages set <file>\``,
            );
        }

        const rows = await this.currentRouting();
        const newestRouting = rows.reduce((newest, { id }) => (BigInt(id) > newest ? BigInt(id) : newest), 0n);
        const id = `${row.id}:${newestRouting}`;
        const cached = parsedByProject.get(project);
        if (cached && cached.id === id) return cached.value;

        const value = parseStages(row.yaml, `stage config ${row.id}`, routingByStage(rows));
        parsedByProject.set(project, { id, value });
        return value;
    }

    async read(): Promise<StageConfigDocument | undefined> {
        const row = await this.newest().select(['id', 'yaml', 'message', 'createdAt']).executeTakeFirst();
        return row ? toDocument(row) : undefined;
    }

    async save(yaml: string, message: string): Promise<StageConfigDocument> {
        return this.store(yaml, message, false);
    }

    async moveStoredRouting(): Promise<void> {
        const document = await this.read();
        if (document && splitRouting(document.yaml).inline.size > 0) {
            await this.store(document.yaml, 'Moved routing to wilson.stage_routing', true);
        }
    }

    async importLanes(): Promise<void> {
        const document = await this.read();
        if (!document) return;
        const imported = await this.importedConfigId();
        if (imported !== undefined && imported >= BigInt(document.id)) return;

        const config = lanesFromDocument(document.yaml, routingByStage(await this.currentRouting()), `stage config ${document.id}`);
        await this.db.transaction().execute(trx => this.writeLanes(trx, config, document.id, `Imported from stage config ${document.id}`));
    }

    async lanes(): Promise<Lane[]> {
        await this.importLanes();
        const rows = await this.db.selectFrom('wilson.lanes').selectAll().where('project', '=', this.config.project).orderBy('position').execute();
        return rows.map(toLane);
    }

    async patchLane(name: string, patch: LanePatch, message: string): Promise<Lane> {
        await this.importLanes();
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
            await this.writeLanes(trx, next, settings.importedConfigId, message);
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

    /** Validate and write a document and the routing it carries, together. `keepRows` lets a row win over the document. */
    private async store(submitted: string, message: string, keepRows: boolean): Promise<StageConfigDocument> {
        const routing = routingByStage(await this.currentRouting());
        const { yaml, inline } = splitRouting(submitted);
        const changes = planRoutingChanges(submitted, routing, inline, keepRows);

        return this.db.transaction().execute(async trx => {
            if (changes.length > 0) {
                await trx
                    .insertInto('wilson.stageRouting')
                    .values(changes.map(change => ({ project: this.config.project, ...change, message })))
                    .execute();
            }
            const row = await trx
                .insertInto('wilson.stageConfigs')
                .values({ project: this.config.project, yaml, message })
                .returning(['id', 'yaml', 'message', 'createdAt'])
                .executeTakeFirstOrThrow();

            const after = new Map(routing);
            for (const { stage, ...fields } of changes) after.set(stage, fields);
            await this.writeLanes(trx, lanesFromDocument(yaml, after, 'the submitted stage config'), row.id, message);

            return toDocument(row);
        });
    }

    /** Make the lane tables say `config`, recording a revision for each thing that changed and nothing else. */
    private async writeLanes(trx: Transaction<DB>, config: LaneConfig, configId: string | number | bigint, message: string): Promise<void> {
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
            importedConfigId: BigInt(configId),
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

    /** The config in the lane tables, cached the way a parsed document is, on the newest revision. */
    private async loadLanes(): Promise<ProjectStages> {
        const project = this.config.project;
        const newest = await this.db
            .selectFrom('wilson.laneRevisions')
            .select('id')
            .where('project', '=', project)
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();
        const id = `lanes:${newest?.id}`;
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

    /** The newest document the lane tables reflect, or undefined when they have never been filled. */
    private async importedConfigId(): Promise<bigint | undefined> {
        const row = await this.db
            .selectFrom('wilson.projectLaneSettings')
            .select('importedConfigId')
            .where('project', '=', this.config.project)
            .executeTakeFirst();
        return row ? BigInt(row.importedConfigId) : undefined;
    }

    async versions(limit = 20): Promise<StageConfigVersionSummary[]> {
        const rows = await this.db
            .selectFrom('wilson.stageConfigs')
            .select(['id', 'message', 'createdAt'])
            .where('project', '=', this.config.project)
            .orderBy('id', 'desc')
            .limit(limit)
            .execute();
        return rows.map(row => ({ id: String(row.id), message: row.message, createdAt: row.createdAt }));
    }

    async saveRouting(stage: string, routing: StageRouting, message: string): Promise<void> {
        const { isolated, mode } = findStage(await this.load(), stage);
        if (!runsModel({ name: stage, mode })) throw new StageConfigError('config-invalid', `${stage} runs no model, so it has no routing to set`);
        assertRoutable(stage, routing, isolated);

        const project = this.config.project;
        await this.db.transaction().execute(async trx => {
            await trx
                .insertInto('wilson.stageRouting')
                .values({ project, stage, ...routing, message })
                .execute();

            const lane = await trx
                .updateTable('wilson.lanes')
                .set({ ...routing, updatedAt: DateTime.now() })
                .where('project', '=', project)
                .where('name', '=', stage)
                .returningAll()
                .executeTakeFirst();
            if (lane) {
                await trx
                    .insertInto('wilson.laneRevisions')
                    .values({ project, lane: stage, snapshot: JSON.stringify(toLane(lane)), message })
                    .execute();
            }
        });
    }

    /** The newest `wilson.stage_routing` row for each of the current project's stages. */
    private currentRouting() {
        return this.db
            .selectFrom('wilson.stageRouting')
            .distinctOn('stage')
            .select(['id', 'stage', 'adapter', 'provider', 'model'])
            .where('project', '=', this.config.project)
            .orderBy('stage')
            .orderBy('id', 'desc')
            .execute();
    }

    /** The current project's newest row — its current config. */
    private newest() {
        return this.db.selectFrom('wilson.stageConfigs').where('project', '=', this.config.project).orderBy('id', 'desc').limit(1);
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
 * Validate a submitted document, and work out which routing rows saving it has to add.
 *
 * Only a stage the document names routing for gets one, and only if that changes anything. A field
 * the document leaves out keeps the stage's current value.
 */
const planRoutingChanges = (
    submitted: string,
    routing: ReadonlyMap<string, StageRouting>,
    inline: ReadonlyMap<string, Partial<StageRouting>>,
    keepRows: boolean,
): (StageRouting & { stage: string })[] => {
    const merged = new Map(routing);
    for (const [stage, fields] of inline) {
        const row = routing.get(stage);
        if (row && !keepRows) merged.set(stage, { ...row, ...fields });
    }
    const parsed = parseStages(submitted, 'the submitted stage config', merged);

    return parsed.stages.flatMap(({ name, adapter, provider, model }) => {
        const row = routing.get(name);
        const unchanged = row?.adapter === adapter && row.provider === provider && row.model === model;
        return inline.has(name) && !unchanged && model ? [{ stage: name, adapter, provider, model }] : [];
    });
};

const toDocument = (row: { id: string | number | bigint; yaml: string; message: string; createdAt: DateTime }): StageConfigDocument => ({
    id: String(row.id),
    yaml: row.yaml,
    message: row.message,
    createdAt: row.createdAt,
});

/**
 * An in-memory store holding one project's documents, for tests — the counterpart of
 * `StaticBoardConfig`. Construct it with the YAML a test wants `load` to answer with; `save`
 * behaves as the real one does (validate, then append), so a test of the edit surface can use it
 * without a database.
 */
export class StaticStageConfigStore extends StageConfigStore {
    private readonly documents: StageConfigDocument[] = [];
    private readonly routing = new Map<string, StageRouting>();
    private readonly revisions: LaneRevision[] = [];

    constructor(yaml?: string, message = 'initial') {
        super();
        if (yaml !== undefined) this.documents.push(this.document(yaml, message));
    }

    async load(): Promise<ProjectStages> {
        const current = this.documents.at(-1);
        if (!current) throw new StageConfigError('config-invalid', 'no stage config');
        return parseStages(current.yaml, `stage config ${current.id}`, this.routing);
    }

    async read(): Promise<StageConfigDocument | undefined> {
        return this.documents.at(-1);
    }

    async save(submitted: string, message: string): Promise<StageConfigDocument> {
        const { yaml, inline } = splitRouting(submitted);
        for (const change of planRoutingChanges(submitted, this.routing, inline, false)) {
            const { stage, ...routing } = change;
            this.routing.set(stage, routing);
        }
        const document = this.document(yaml, message);
        this.documents.push(document);
        return document;
    }

    async versions(limit = 20): Promise<StageConfigVersionSummary[]> {
        return [...this.documents]
            .reverse()
            .slice(0, limit)
            .map(({ id, message, createdAt }) => ({ id, message, createdAt }));
    }

    async saveRouting(stage: string, routing: StageRouting): Promise<void> {
        const { isolated } = findStage(await this.load(), stage);
        assertRoutable(stage, routing, isolated);
        this.routing.set(stage, routing);
    }

    async moveStoredRouting(): Promise<void> {}

    async importLanes(): Promise<void> {}

    private config(): LaneConfig | undefined {
        const current = this.documents.at(-1);
        return current && lanesFromDocument(current.yaml, this.routing, `stage config ${current.id}`);
    }

    async lanes(): Promise<Lane[]> {
        return this.config()?.lanes ?? [];
    }

    async patchLane(name: string, patch: LanePatch, message: string): Promise<Lane> {
        const config = this.config();
        if (!config) throw new StageConfigError('stage-not-found', 'no stage config');
        const next = patchLane(config, name, patch, `lane "${name}"`);
        this.documents.push(this.document(JSON.stringify(documentFromLanes(next)), message));
        this.revisions.unshift({ id: String(this.revisions.length + 1), lane: name, message, createdAt: DateTime.now() });
        return next.lanes.find(lane => lane.name === name)!;
    }

    async laneRevisions(lane: string | undefined, limit: number): Promise<LaneRevision[]> {
        return this.revisions.filter(revision => lane === undefined || revision.lane === lane).slice(0, limit);
    }

    private document(yaml: string, message: string): StageConfigDocument {
        return { id: String(this.documents.length + 1), yaml, message, createdAt: DateTime.now() };
    }
}
