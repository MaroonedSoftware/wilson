import { Kysely, type Selectable } from 'kysely';
import { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB, WilsonReviews } from '#modules/data/db.js';

export type ReviewStatus = 'open' | 'changes_requested' | 'approved' | 'superseded';

export interface StoredReview {
    id: string;
    head: string;
    base: string;
    status: ReviewStatus;
    verdictAt: DateTime | undefined;
    createdAt: DateTime;
}

const toStoredReview = (row: Selectable<WilsonReviews>): StoredReview => ({
    id: String(row.id),
    head: row.headSha,
    base: row.baseSha,
    status: row.status,
    verdictAt: row.verdictAt ?? undefined,
    createdAt: row.createdAt,
});

/**
 * `wilson.reviews`. Not `@Injectable()`, for the reason `PlanCommentRepository` is not: no polymorphic
 * swap, and its one caller already holds both constructor arguments.
 */
export class ReviewRepository {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {}

    /** The card's newest review, whatever its status. */
    async latest(cardId: string): Promise<StoredReview | undefined> {
        const row = await this.db
            .selectFrom('wilson.reviews')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();
        return row && toStoredReview(row);
    }

    /** Close the card's open review at a verdict. */
    async conclude(cardId: string, reviewId: string, status: 'changes_requested' | 'approved'): Promise<void> {
        await this.db
            .updateTable('wilson.reviews')
            .set({ status, verdictAt: DateTime.now() })
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('id', '=', BigInt(reviewId))
            .execute();
    }

    /**
     * The card's open review at `head`, starting one if there is none and retiring any open one at
     * another commit. Two people opening at once both get the one row, because the partial unique
     * index turns the second insert into a no-op.
     */
    async openAt(cardId: string, head: string, base: string): Promise<StoredReview> {
        return this.db.transaction().execute(async trx => {
            await trx
                .updateTable('wilson.reviews')
                .set({ status: 'superseded' })
                .where('project', '=', this.config.project)
                .where('cardId', '=', cardId)
                .where('status', '=', 'open')
                .where('headSha', '!=', head)
                .execute();
            await trx
                .insertInto('wilson.reviews')
                .values({ project: this.config.project, cardId, headSha: head, baseSha: base })
                .onConflict(conflict => conflict.columns(['project', 'cardId']).where('status', '=', 'open').doNothing())
                .execute();
            const row = await trx
                .selectFrom('wilson.reviews')
                .selectAll()
                .where('project', '=', this.config.project)
                .where('cardId', '=', cardId)
                .where('status', '=', 'open')
                .executeTakeFirstOrThrow();
            return toStoredReview(row);
        });
    }
}
