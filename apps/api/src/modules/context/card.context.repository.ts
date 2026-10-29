import { Kysely } from 'kysely';
import type { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';

export interface CardContext {
    id: string;
    sourceUrl: string;
    fetchedAt: DateTime;
    fetchedBy: string;
    title?: string;
    content: string;
    contentHash: string;
    createdAt: DateTime;
}

/**
 * `wilson.card_context` — a snapshot of external context attached to a card. Follows
 * `PlanCommentRepository`'s shape: constructed with `BoardConfig` and the shared `Kysely<DB>` pool
 * rather than resolved through the container.
 *
 * Not `@Injectable()`: unlike `PostgresBoardRepository`'s constructor-injected dependencies, a
 * `@Injectable()`/`.useClass()` pair buys nothing here that a factory doesn't already give more
 * directly. `ContextModule` registers this token with `.useFactory(container => new
 * CardContextRepository(container.get(BoardConfig), container.get(Kysely<DB>)))` — the same two
 * arguments a decorator's reflection would have resolved, spelled out instead of inferred.
 *
 * `ContextService` (card 0187) is the one caller: it resolves a URL through
 * `ContextProviderRegistry`, calls the `ContextProvider` that handles it, and writes what came back
 * through `attach` below. See the migration (`data/migrations/20261029000500_board.sql`) for
 * what a row holds and why.
 */
export class CardContextRepository {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {}

    /** Record a new context snapshot on a card. */
    async attach(
        cardId: string,
        sourceUrl: string,
        fetchedAt: DateTime,
        fetchedBy: string,
        title: string | undefined,
        content: string,
        contentHash: string,
    ): Promise<CardContext> {
        const row = await this.db
            .insertInto('wilson.cardContext')
            .values({
                project: this.config.project,
                cardId,
                sourceUrl,
                fetchedAt,
                fetchedBy,
                title: title ?? null,
                content,
                contentHash,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

        return toCardContext(row);
    }

    /** A card's context snapshots, oldest first. */
    async list(cardId: string): Promise<CardContext[]> {
        const rows = await this.db
            .selectFrom('wilson.cardContext')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .orderBy('id')
            .execute();
        return rows.map(toCardContext);
    }

    /** One snapshot by id, or `undefined` if it does not exist or belongs to another project. */
    async get(id: string): Promise<CardContext | undefined> {
        const row = await this.db
            .selectFrom('wilson.cardContext')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('id', '=', id)
            .executeTakeFirst();
        return row ? toCardContext(row) : undefined;
    }

    /**
     * Delete one snapshot. A real delete, not a `resolved`-style state: unlike a plan comment, a
     * snapshot has no history worth keeping once a person says it was the wrong document. Scoped by
     * `cardId` as well as `id`, mirroring `PlanCommentRepository.resolve` — the caller passes both
     * because they came from the same two path params, and a snapshot id that exists but belongs to
     * a different card in this project must miss exactly like one that does not exist at all.
     * Returns whether a row was actually deleted, so `ContextService` can tell that miss apart from
     * a real removal and answer with its own 404.
     */
    async remove(cardId: string, id: string): Promise<boolean> {
        const result = await this.db
            .deleteFrom('wilson.cardContext')
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('id', '=', id)
            .executeTakeFirst();
        return (result?.numDeletedRows ?? 0n) > 0n;
    }
}

function toCardContext(row: {
    id: string;
    sourceUrl: string;
    fetchedAt: DateTime;
    fetchedBy: string;
    title: string | null;
    content: string;
    contentHash: string;
    createdAt: DateTime;
}): CardContext {
    return {
        id: String(row.id),
        sourceUrl: row.sourceUrl,
        fetchedAt: row.fetchedAt,
        fetchedBy: row.fetchedBy,
        title: row.title ?? undefined,
        content: row.content,
        contentHash: row.contentHash,
        createdAt: row.createdAt,
    };
}
