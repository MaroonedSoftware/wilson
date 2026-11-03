import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import { httpError } from '@maroonedsoftware/errors';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import type { Card } from '#modules/board/card.js';
import { CardNotFoundError } from '#modules/board/postgres.board.repository.js';
import type { DB } from '#modules/data/db.js';
import { StageConfigError } from '#modules/stages/stage.config.js';
import type { DiffFileEntry } from '#modules/worktree/worktree.manager.js';
import type { HumanFinding } from '../../generated/board.js';
import type { CreateReviewCommentRequest, Review, ReviewComment, ReviewState, ReviewVerdictRequest } from '../../generated/review.js';
import { captureLineAnchor, locateLineAnchor } from './review.anchor.js';
import { ReviewCommentRepository, type StoredReviewComment } from './review.comment.repository.js';
import { DiffSource } from './review.diff.source.js';
import { ReviewRepository, type StoredReview } from './review.repository.js';

/** The one stage a review can be written in. `recordFindings` refuses the rest, and earlier stages can move the branch. */
const REVIEW_STAGE = 'ready';

const toWireReview = (review: StoredReview, currentHead: string | undefined): Review => ({
    id: review.id,
    head: review.head,
    base: review.base,
    status: review.status,
    stale: currentHead !== undefined && currentHead !== review.head,
    createdAt: review.createdAt,
    verdictAt: review.verdictAt,
});

const toWireComment = (comment: StoredReviewComment, files: DiffFileEntry[]): ReviewComment => {
    const located = locateLineAnchor(comment, files);
    return {
        id: comment.id,
        reviewId: comment.reviewId,
        head: comment.head,
        file: comment.file,
        side: comment.side,
        line: comment.line,
        lineText: comment.lineText,
        severity: comment.severity,
        text: comment.text,
        status: comment.status,
        location: located.location,
        currentLine: located.location === 'found' ? located.currentLine : undefined,
        createdAt: comment.createdAt,
    };
};

/**
 * A comment as `recordFindings` takes it. A comment is one piece of text and a finding asks for two, so
 * `suggestion` carries what the implementer can't get from `file:line`: the line itself, which still
 * identifies it after a rebase, and whether it is a line the change removed.
 */
const toFinding = (comment: StoredReviewComment, files: DiffFileEntry[]): HumanFinding => {
    const located = locateLineAnchor(comment, files);
    const line = located.location === 'found' ? located.currentLine : comment.line;
    return {
        file: comment.file,
        line,
        severity: comment.severity,
        problem: comment.text,
        suggestion: `On ${comment.side === 'old' ? 'removed ' : ''}line ${line}: \`${comment.lineText.trim()}\``,
    };
};

/**
 * `review.ck`: a person's review of a card's branch. Reads work in any stage. Writes need the card in
 * `ready`, the human gate, so a project with no such stage simply has no way to start one.
 */
@Injectable()
export class ReviewService {
    private readonly reviews: ReviewRepository;
    private readonly comments: ReviewCommentRepository;

    constructor(
        private readonly boardRepository: BoardRepository,
        private readonly boardConfig: BoardConfig,
        private readonly diffs: DiffSource,
        private readonly db: Kysely<DB>,
        private readonly boardWrites: BoardWriteService,
    ) {
        this.reviews = new ReviewRepository(this.boardConfig, this.db);
        this.comments = new ReviewCommentRepository(this.boardConfig, this.db);
    }

    async state(id: string): Promise<ReviewState> {
        return this.stateOf(await this.readOrThrow(id));
    }

    /** Rejoin the review of the branch's current commit, or start one. A verdict at that commit stands. */
    async open(id: string): Promise<ReviewState> {
        const card = await this.readOrThrow(id);
        this.assertReviewable(card);
        const diff = await this.currentDiff(card);
        const latest = await this.reviews.latest(id);
        if (!(latest?.head === diff.head && latest.status === 'approved')) {
            await this.reviews.openAt(id, diff.head, diff.base);
        }
        return this.stateOf(card);
    }

    async addComment(id: string, request: CreateReviewCommentRequest): Promise<ReviewComment> {
        const text = request.text.trim();
        if (text.length === 0) throw httpError(400).withDetails({ reason: 'a comment needs some text' });

        const card = await this.readOrThrow(id);
        this.assertReviewable(card);
        const diff = await this.currentDiff(card);
        this.assertSameHead(id, request.head, diff.head);

        const file = diff.files.find(candidate => candidate.path === request.file);
        const anchor = file && captureLineAnchor(file, request.side, request.line);
        if (!anchor) {
            throw httpError(400).withDetails({ reason: `${request.file}:${request.line} is not on the ${request.side} side of this diff` });
        }

        const review = await this.reviews.openAt(id, diff.head, diff.base);
        const comment = await this.comments.append(id, {
            reviewId: review.id,
            head: diff.head,
            line: request.line,
            anchor,
            severity: request.severity ?? 'blocker',
            text,
        });
        return toWireComment(comment, diff.files);
    }

    async resolveComment(id: string, commentId: string): Promise<ReviewComment> {
        const card = await this.readOrThrow(id);
        this.assertReviewable(card);
        // Not a Postgres `id` at all, which the query would fail on rather than find nothing.
        if (!/^\d+$/.test(commentId)) throw httpError(404);
        const resolved = await this.comments.resolve(id, commentId);
        if (!resolved) throw httpError(404);
        return toWireComment(resolved, await this.filesNow(card));
    }

    /**
     * Send every open comment to the implementer, as one kickback. The card moves first and the
     * comments are marked after, so a failure between the two leaves them open and visible rather than
     * marked sent without having gone anywhere.
     */
    async requestChanges(id: string, request: ReviewVerdictRequest): Promise<ReviewState> {
        const card = await this.readOrThrow(id);
        this.assertReviewable(card);
        const diff = await this.currentDiff(card);
        this.assertSameHead(id, request.head, diff.head);

        const open = (await this.comments.list(id)).filter(comment => comment.status === 'open');
        if (open.length === 0) throw httpError(400).withDetails({ reason: `${id} has no open comments to send` });

        const review = await this.reviews.openAt(id, diff.head, diff.base);
        try {
            await this.boardWrites.recordFindings(id, { findings: open.map(comment => toFinding(comment, diff.files)) });
        } catch (err) {
            if (err instanceof StageConfigError && err.kind === 'stage-not-found') {
                throw httpError(400).withDetails({
                    reason: `project "${this.boardConfig.project}" has no "${REVIEW_STAGE}" stage to send findings from`,
                });
            }
            throw err;
        }
        await this.comments.markSent(
            id,
            open.map(comment => comment.id),
        );
        await this.reviews.conclude(id, review.id, 'changes_requested');
        return this.stateOf(await this.readOrThrow(id));
    }

    private async stateOf(card: Card): Promise<ReviewState> {
        const id = card.frontmatter.id;
        const [latest, comments, read] = await Promise.all([this.reviews.latest(id), this.comments.list(id), this.diffs.read(card)]);
        const files = read.ok ? read.files : [];
        return {
            review: latest && toWireReview(latest, read.ok ? read.head : undefined),
            comments: comments.map(comment => toWireComment(comment, files)),
        };
    }

    private async filesNow(card: Card): Promise<DiffFileEntry[]> {
        const read = await this.diffs.read(card);
        return read.ok ? read.files : [];
    }

    private async currentDiff(card: Card) {
        const read = await this.diffs.read(card);
        if (!read.ok) throw httpError(400).withDetails({ reason: read.reason });
        return read;
    }

    private assertSameHead(id: string, seen: string, current: string): void {
        if (seen !== current) {
            throw httpError(409).withDetails({ reason: `${id}'s branch has moved on from ${seen.slice(0, 7)}; reload the diff` });
        }
    }

    private assertReviewable(card: Card): void {
        if (card.frontmatter.stage !== REVIEW_STAGE) {
            throw httpError(400).withDetails({
                reason: `cannot review ${card.frontmatter.id}: it is in "${card.frontmatter.stage}", not "${REVIEW_STAGE}"`,
            });
        }
    }

    private async readOrThrow(id: string): Promise<Card> {
        try {
            return await this.boardRepository.read(id);
        } catch (err) {
            if (err instanceof CardNotFoundError) throw httpError(404);
            throw err;
        }
    }
}
