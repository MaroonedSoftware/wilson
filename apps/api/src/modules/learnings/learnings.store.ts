import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';

/** One stored learnings document — a `runner.learnings` row, as a caller sees it. */
export interface LearningsDocument {
    id: string;
    markdown: string;
    message: string;
    createdAt: DateTime;
}

/** One row of a project's learnings history. */
export interface LearningsVersionSummary {
    id: string;
    message: string;
    createdAt: DateTime;
}

/**
 * Where a project's human-approved learnings document comes from.
 *
 * Clones `StageConfigStore`'s shape (`apps/api/src/modules/stages/stage.config.store.ts`): append-only,
 * the newest row per project is the current document, and every save carries a `message` — the same
 * `git log` on a file used to answer, now a `runner.learnings` row.
 *
 * Unlike stage config, a learnings document has no schema to validate: `markdown` is free text, so
 * `save` never refuses one, and `load` never throws — this document is human-write-only (PROJECT.md
 * decision 8) and card 0244's agent-facing read path treats "no document yet" the same as "an empty
 * one", not as a fact to raise.
 *
 * Abstract for the same reason `StageConfigStore` is: production wires the Postgres implementation
 * below through DI, and a test that only needs "some document" constructs `StaticLearningsStore` with
 * a string rather than seeding a database row.
 */
@Injectable()
export abstract class LearningsStore {
    /** The current project's markdown, or the empty string when it has no document yet. */
    abstract load(): Promise<string>;

    /** The current project's stored document, or undefined when it has none yet. */
    abstract read(): Promise<LearningsDocument | undefined>;

    /** Store a new document as the current project's learnings. Every save is a new row: the previous
     * document stays in the history. An empty `markdown` is a valid save — the operator's way to
     * retire every learning at once without deleting the history. */
    abstract save(markdown: string, message: string): Promise<LearningsDocument>;

    /** The current project's learnings history, newest first. */
    abstract versions(limit?: number): Promise<LearningsVersionSummary[]>;
}

/**
 * `runner.learnings`, in Postgres.
 *
 * Keyed by `BoardConfig.project` the way `PostgresStageConfigStore` is, read fresh on every call —
 * so under `runAsProject` (project.context.ts) the same instance answers for whichever project's
 * work is on the call stack, with nothing here knowing several exist.
 */
@Injectable()
export class PostgresLearningsStore extends LearningsStore {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {
        super();
    }

    async load(): Promise<string> {
        const row = await this.newest().select(['markdown']).executeTakeFirst();
        return row?.markdown ?? '';
    }

    async read(): Promise<LearningsDocument | undefined> {
        const row = await this.newest().select(['id', 'markdown', 'message', 'createdAt']).executeTakeFirst();
        return row ? toDocument(row) : undefined;
    }

    async save(markdown: string, message: string): Promise<LearningsDocument> {
        const row = await this.db
            .insertInto('runner.learnings')
            .values({ project: this.config.project, markdown, message })
            .returning(['id', 'markdown', 'message', 'createdAt'])
            .executeTakeFirstOrThrow();
        return toDocument(row);
    }

    async versions(limit = 20): Promise<LearningsVersionSummary[]> {
        const rows = await this.db
            .selectFrom('runner.learnings')
            .select(['id', 'message', 'createdAt'])
            .where('project', '=', this.config.project)
            .orderBy('id', 'desc')
            .limit(limit)
            .execute();
        return rows.map(row => ({ id: String(row.id), message: row.message, createdAt: row.createdAt }));
    }

    /** The current project's newest row — its current document. */
    private newest() {
        return this.db.selectFrom('runner.learnings').where('project', '=', this.config.project).orderBy('id', 'desc').limit(1);
    }
}

const toDocument = (row: { id: string | number | bigint; markdown: string; message: string; createdAt: DateTime }): LearningsDocument => ({
    id: String(row.id),
    markdown: row.markdown,
    message: row.message,
    createdAt: row.createdAt,
});

/**
 * An in-memory store holding one project's documents, for tests — the counterpart of
 * `StaticStageConfigStore`. Construct it with the markdown a test wants `load`/`read` to answer
 * with; `save` behaves as the real one does (append, never refuse), so a test of the edit surface
 * can use it without a database.
 */
export class StaticLearningsStore extends LearningsStore {
    private readonly documents: LearningsDocument[] = [];

    constructor(markdown?: string, message = 'initial') {
        super();
        if (markdown !== undefined) this.documents.push(this.document(markdown, message));
    }

    async load(): Promise<string> {
        return this.documents.at(-1)?.markdown ?? '';
    }

    async read(): Promise<LearningsDocument | undefined> {
        return this.documents.at(-1);
    }

    async save(markdown: string, message: string): Promise<LearningsDocument> {
        const document = this.document(markdown, message);
        this.documents.push(document);
        return document;
    }

    async versions(limit = 20): Promise<LearningsVersionSummary[]> {
        return [...this.documents]
            .reverse()
            .slice(0, limit)
            .map(({ id, message, createdAt }) => ({ id, message, createdAt }));
    }

    private document(markdown: string, message: string): LearningsDocument {
        return { id: String(this.documents.length + 1), markdown, message, createdAt: DateTime.now() };
    }
}
