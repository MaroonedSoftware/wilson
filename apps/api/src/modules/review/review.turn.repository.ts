import { Kysely } from 'kysely';
import type { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';

export interface StoredReviewTurn {
    seq: number;
    role: 'user' | 'assistant';
    content: string;
    createdAt: DateTime;
}

/**
 * `wilson.review_turns`. Keyed by review alone, whose id is already project-scoped by whoever looked it
 * up (`ReviewRepository`), so this takes no `BoardConfig`.
 */
export class ReviewTurnRepository {
    constructor(private readonly db: Kysely<DB>) {}

    async list(reviewId: string): Promise<StoredReviewTurn[]> {
        return this.db
            .selectFrom('wilson.reviewTurns')
            .select(['seq', 'role', 'content', 'createdAt'])
            .where('reviewId', '=', BigInt(reviewId))
            .orderBy('seq')
            .execute();
    }

    /** Append the next turn. Callers hold the review's lock, so the next `seq` can't be taken from under them. */
    async append(reviewId: string, role: StoredReviewTurn['role'], content: string, outputTokens?: number): Promise<StoredReviewTurn> {
        const { next } = await this.db
            .selectFrom('wilson.reviewTurns')
            .select(eb => eb.fn.coalesce(eb.fn.max('seq'), eb.lit(0)).as('next'))
            .where('reviewId', '=', BigInt(reviewId))
            .executeTakeFirstOrThrow();
        return this.db
            .insertInto('wilson.reviewTurns')
            .values({ reviewId: BigInt(reviewId), seq: Number(next) + 1, role, content, outputTokens })
            .returning(['seq', 'role', 'content', 'createdAt'])
            .executeTakeFirstOrThrow();
    }
}
