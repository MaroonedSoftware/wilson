import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';
import { parseStages, StageConfigError, type ProjectStages } from './stage.config.js';

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
     */
    abstract save(yaml: string, message: string): Promise<StageConfigDocument>;

    /** The current project's config history, newest first. */
    abstract versions(limit?: number): Promise<StageConfigVersionSummary[]>;
}

/**
 * The last successfully parsed config per project, with the row id it was parsed from.
 *
 * `load` runs on every dispatch twice over (`StageDispatcher.run` and `CardStageJob.runStage`), on
 * every poller tick and from several API routes, and a parse is a YAML parse, a zod validation and a
 * route check of a document that changes only when a person saves it. The row's id is the cache key:
 * every save is a new row with a higher id, so "the newest id is the one I parsed" is exactly "the
 * document has not changed". One cheap `SELECT id, yaml` per call replaces the `stat` the file
 * cache used, and the frozen object is shared across callers the same way.
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
        if (!row) {
            throw new StageConfigError(
                'config-invalid',
                `project "${project}" has no stage config; run \`wilson board init\` or \`wilson stages set <file>\``,
            );
        }

        const id = String(row.id);
        const cached = parsedByProject.get(project);
        if (cached && cached.id === id) return cached.value;

        const value = parseStages(row.yaml, `stage config ${id}`);
        parsedByProject.set(project, { id, value });
        return value;
    }

    async read(): Promise<StageConfigDocument | undefined> {
        const row = await this.newest().select(['id', 'yaml', 'message', 'createdAt']).executeTakeFirst();
        return row ? toDocument(row) : undefined;
    }

    async save(yaml: string, message: string): Promise<StageConfigDocument> {
        parseStages(yaml, 'the submitted stage config');

        const row = await this.db
            .insertInto('wilson.stageConfigs')
            .values({ project: this.config.project, yaml, message })
            .returning(['id', 'yaml', 'message', 'createdAt'])
            .executeTakeFirstOrThrow();
        return toDocument(row);
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

    /** The current project's newest row — its current config. */
    private newest() {
        return this.db.selectFrom('wilson.stageConfigs').where('project', '=', this.config.project).orderBy('id', 'desc').limit(1);
    }
}

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

    constructor(yaml?: string, message = 'initial') {
        super();
        if (yaml !== undefined) this.documents.push(this.document(yaml, message));
    }

    async load(): Promise<ProjectStages> {
        const current = this.documents.at(-1);
        if (!current) throw new StageConfigError('config-invalid', 'no stage config');
        return parseStages(current.yaml, `stage config ${current.id}`);
    }

    async read(): Promise<StageConfigDocument | undefined> {
        return this.documents.at(-1);
    }

    async save(yaml: string, message: string): Promise<StageConfigDocument> {
        parseStages(yaml, 'the submitted stage config');
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

    private document(yaml: string, message: string): StageConfigDocument {
        return { id: String(this.documents.length + 1), yaml, message, createdAt: DateTime.now() };
    }
}
