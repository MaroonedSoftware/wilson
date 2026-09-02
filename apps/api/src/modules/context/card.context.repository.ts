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
 * `runner.card_context` — a snapshot of external context attached to a card. Follows
 * `PlanCommentRepository`'s shape: constructed with `BoardConfig` and the shared `Kysely<DB>` pool
 * rather than resolved through the container.
 *
 * Not `@Injectable()`, for the same reason `PlanCommentRepository` is not — no polymorphic swap,
 * and every future caller already holds the two constructor arguments, so `new` is simpler than a
 * registration this card's files in scope have nowhere to add.
 *
 * A mechanism with no consumer, deliberately: the `ContextProvider` interface and the URL provider
 * that would populate this table are the provider-seam card, and the HTTP surface that would call
 * `attach` is the contract card. Nothing calls this repository yet. See the migration
 * (`data/migrations/20260902120000_card_context.sql`) for what a row holds and why.
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
            .insertInto('runner.cardContext')
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
            .selectFrom('runner.cardContext')
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
            .selectFrom('runner.cardContext')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('id', '=', id)
            .executeTakeFirst();
        return row ? toCardContext(row) : undefined;
    }

    /**
     * Delete one snapshot. A real delete, not a `resolved`-style state: unlike a plan comment, a
     * snapshot has no history worth keeping once a person says it was the wrong document. Safe to
     * call for an id that does not exist, or does not belong to this project.
     */
    async remove(id: string): Promise<void> {
        await this.db.deleteFrom('runner.cardContext').where('project', '=', this.config.project).where('id', '=', id).execute();
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
