import { Kysely, type Selectable } from 'kysely';
import { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB, WilsonReviewComments } from '#modules/data/db.js';
import type { DiffSide } from './diff.hunks.js';
import type { LineAnchor } from './review.anchor.js';

export type ReviewCommentSeverity = 'blocker' | 'concern';
export type ReviewCommentStatus = 'open' | 'resolved' | 'sent';

export interface StoredReviewComment extends LineAnchor {
    id: string;
    reviewId: string;
    head: string;
    side: DiffSide;
    line: number;
    severity: ReviewCommentSeverity;
    text: string;
    status: ReviewCommentStatus;
    createdAt: DateTime;
}

export interface NewReviewComment {
    reviewId: string;
    head: string;
    line: number;
    anchor: LineAnchor;
    severity: ReviewCommentSeverity;
    text: string;
}

const toStoredComment = (row: Selectable<WilsonReviewComments>): StoredReviewComment => ({
    id: String(row.id),
    reviewId: String(row.reviewId),
    head: row.headSha,
    file: row.file,
    side: row.side,
    line: row.line,
    lineText: row.lineText,
    contextBefore: row.contextBefore,
    contextAfter: row.contextAfter,
    severity: row.severity,
    text: row.text,
    status: row.status,
    createdAt: row.createdAt,
});

/** `wilson.review_comments`, shaped as `ReviewRepository` is. */
export class ReviewCommentRepository {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {}

    async append(cardId: string, comment: NewReviewComment): Promise<StoredReviewComment> {
        const row = await this.db
            .insertInto('wilson.reviewComments')
            .values({
                project: this.config.project,
                cardId,
                reviewId: BigInt(comment.reviewId),
                headSha: comment.head,
                file: comment.anchor.file,
                side: comment.anchor.side,
                line: comment.line,
                lineText: comment.anchor.lineText,
                contextBefore: comment.anchor.contextBefore,
                contextAfter: comment.anchor.contextAfter,
                severity: comment.severity,
                text: comment.text,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        return toStoredComment(row);
    }

    /** Every comment on a card, across all its reviews, oldest first. */
    async list(cardId: string): Promise<StoredReviewComment[]> {
        const rows = await this.db
            .selectFrom('wilson.reviewComments')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .orderBy('id')
            .execute();
        return rows.map(toStoredComment);
    }

    /** Mark comments as handed to the implementer. */
    async markSent(cardId: string, commentIds: string[]): Promise<void> {
        await this.db
            .updateTable('wilson.reviewComments')
            .set({ status: 'sent' })
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('id', 'in', commentIds.map(BigInt))
            .execute();
    }

    /** Resolve one open comment. `undefined` when it is not this card's, or is no longer open. */
    async resolve(cardId: string, commentId: string): Promise<StoredReviewComment | undefined> {
        const row = await this.db
            .updateTable('wilson.reviewComments')
            .set({ status: 'resolved' })
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('id', '=', BigInt(commentId))
            .where('status', '=', 'open')
            .returningAll()
            .executeTakeFirst();
        return row && toStoredComment(row);
    }
}
