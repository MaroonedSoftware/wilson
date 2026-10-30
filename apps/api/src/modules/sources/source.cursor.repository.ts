import type { Kysely } from 'kysely';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';

/**
 * `wilson.source_cursors` — where each registered `CardSource` left off, one row per `(project,
 * source)`. Follows `CardContextRepository`'s shape (`#modules/context/card.context.repository.js`):
 * constructed with `BoardConfig` and the shared `Kysely<DB>` pool rather than resolved through the
 * container, and not `@Injectable()` for the same reason that class gives — `SourcesModule` registers
 * this token with `.useFactory`, spelling out the two arguments a decorator's reflection would have
 * resolved instead of inferring them.
 *
 * `SourcePoller` (`source.poller.ts`) is the one caller: `get` before `changedSince`, `set` after it
 * reports `{ ok: true }`.
 */
export class SourceCursorRepository {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {}

    /**
     * The cursor `source` last left off at, for the current project. `undefined` for a source with no
     * row yet — `CardSource.changedSince`'s own doc documents that as "since the beginning".
     */
    async get(source: string): Promise<string | undefined> {
        const row = await this.db
            .selectFrom('wilson.sourceCursors')
            .select('cursor')
            .where('project', '=', this.config.project)
            .where('source', '=', source)
            .executeTakeFirst();
        return row?.cursor;
    }

    /**
     * Persist where `source` left off, for the next tick to hand back to `changedSince`. Upserts on
     * `(project, source)` — the table's own primary key — rather than accumulating a row per write,
     * the same idiom `SettingsStore.set` already uses for `wilson.settings`.
     */
    async set(source: string, cursor: string): Promise<void> {
        await this.db
            .insertInto('wilson.sourceCursors')
            .values({ project: this.config.project, source, cursor })
            .onConflict(oc => oc.columns(['project', 'source']).doUpdateSet({ cursor }))
            .execute();
    }
}
