import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import { httpError } from '@maroonedsoftware/errors';
import { ServerKitContext } from '@maroonedsoftware/koa';
import { Logger } from '@maroonedsoftware/logger';
import { requireSession } from '#modules/authentication/request.session.js';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import type { Card } from '#modules/board/card.js';
import { CardNotFoundError } from '#modules/board/postgres.board.repository.js';
import { explainError } from '#modules/chat/chat.catalog.js';
import { CHAT_ENGINE, DEFAULT_CHAT_ENGINE } from '#modules/chat/chat.engine.setting.js';
import { CliChatEngine } from '#modules/chat/cli.chat.engine.js';
import { CodeReadRepository } from '#modules/code/code.read.repository.js';
import { CodeReader } from '#modules/code/code.reader.js';
import { auditedRead } from '#modules/code/code.service.js';
import type { DB } from '#modules/data/db.js';
import { EventLog } from '#modules/events/event.log.js';
import { LearningsStore } from '#modules/learnings/learnings.store.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { StageConfigError } from '#modules/stages/stage.config.js';
import { Mutex } from '#src/shared/mutex.js';
import type { DiffFileEntry } from '#modules/worktree/worktree.manager.js';
import { StageConfigStore } from '#modules/stages/stage.config.store.js';
import type { HumanFinding } from '../../generated/board.js';
import type {
    CreateReviewCommentRequest,
    Review,
    ReviewComment,
    ReviewState,
    ReviewTurn,
    ReviewTurnRequest,
    ReviewVerdictRequest,
} from '../../generated/review.js';
import { captureLineAnchor, locateLineAnchor } from './review.anchor.js';
import { ReviewCommentRepository, type StoredReviewComment } from './review.comment.repository.js';
import { DiffSource, type DiffSnapshot } from './review.diff.source.js';
import { publishReview } from './review.feed.js';
import { commentsBlock, firstTurnBlock, reviewSystemPrompt, stepBlock, TOUR_INSTRUCTION } from './review.prompt.js';
import { ReviewRepository, type StoredReview } from './review.repository.js';
import { reviewTools } from './review.tools.js';
import { ReviewTurnRepository } from './review.turn.repository.js';

/** The one stage a review can be written in. `recordFindings` refuses the rest, and earlier stages can move the branch. */
const REVIEW_STAGE = 'ready';

/**
 * How many model steps one turn may take. Walking a change reads many files, which `MAX_CHAT_STEPS` is
 * too tight for. Turns count against no daily ceiling, because a person is driving each one, so this and
 * the account's own usage limit are what bound a turn.
 */
const MAX_REVIEW_STEPS = 60;

/** One lock per review, so a second message sent while the first is being answered waits for it. */
const reviewLocks = new Map<string, Mutex>();
const reviewLock = (reviewId: string): Mutex => {
    let lock = reviewLocks.get(reviewId);
    if (!lock) reviewLocks.set(reviewId, (lock = new Mutex(`review ${reviewId}`)));
    return lock;
};

const toWireReview = (review: StoredReview, currentHead: string | undefined): Review => ({
    id: review.id,
    head: review.head,
    base: review.base,
    status: review.status,
    stale: currentHead !== undefined && currentHead !== review.head,
    createdAt: review.createdAt,
    verdictAt: review.verdictAt,
    tour: review.tour,
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
    private readonly conversation: ReviewTurnRepository;

    constructor(
        private readonly boardRepository: BoardRepository,
        private readonly boardConfig: BoardConfig,
        private readonly diffs: DiffSource,
        private readonly db: Kysely<DB>,
        private readonly boardWrites: BoardWriteService,
        private readonly events: EventLog,
        private readonly engine: CliChatEngine,
        private readonly settings: SettingsStore,
        private readonly learnings: LearningsStore,
        private readonly reads: CodeReadRepository,
        private readonly context: ServerKitContext,
        private readonly logger: Logger,
        private readonly stageConfigs: StageConfigStore,
    ) {
        this.reviews = new ReviewRepository(this.boardConfig, this.db);
        this.comments = new ReviewCommentRepository(this.boardConfig, this.db);
        this.conversation = new ReviewTurnRepository(this.db);
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

    /** Record the person's approval of the branch at `head`. The card stays where it is. */
    async approve(id: string, request: ReviewVerdictRequest): Promise<ReviewState> {
        const card = await this.readOrThrow(id);
        this.assertReviewable(card);
        const diff = await this.currentDiff(card);
        this.assertSameHead(id, request.head, diff.head);

        const blockers = (await this.comments.list(id)).filter(comment => comment.status === 'open' && comment.severity === 'blocker');
        if (blockers.length > 0) {
            throw httpError(400).withDetails({ reason: `cannot approve ${id}: ${blockers.length} open blocker(s) to resolve or send first` });
        }

        const review = await this.reviews.openAt(id, diff.head, diff.base);
        await this.reviews.conclude(id, review.id, 'approved');
        await this.events.append({
            project: this.boardConfig.project,
            cardId: id,
            stage: card.frontmatter.stage,
            type: 'review.approved',
            payload: { head: diff.head },
        });
        return this.stateOf(card);
    }

    /** The current review's conversation, oldest first. Empty for a card nobody has reviewed. */
    async turns(id: string): Promise<ReviewTurn[]> {
        await this.readOrThrow(id);
        const latest = await this.reviews.latest(id);
        return latest ? this.conversation.list(latest.id) : [];
    }

    /**
     * Run one turn of the conversation and store its answer, publishing the text as it is written. The
     * turn runs at the commit the person is looking at. What the person typed is stored as typed: the
     * plan, the comments and the rest of the context go only to the engine.
     */
    async sendTurn(id: string, request: ReviewTurnRequest): Promise<ReviewTurn> {
        const text = request.text.trim();
        if (text.length === 0) throw httpError(400).withDetails({ reason: 'a message needs some text' });

        const card = await this.readOrThrow(id);
        this.assertReviewable(card);
        const diff = await this.currentDiff(card);
        this.assertSameHead(id, request.head, diff.head);

        // `requirePolicy` has already refused a request with no session; this only narrows the type.
        const { subject } = requireSession(this.context);
        const { id: reviewId } = await this.currentReview(id, diff);

        return reviewLock(reviewId).run(
            `${id} review turn`,
            message => this.logger.info(message),
            async () => {
                const review = await this.currentReview(id, diff);
                const history = await this.conversation.list(review.id);
                const prompt = await this.promptFor(card, review, diff, history.length === 0, text, request);
                await this.conversation.append(review.id, 'user', text);

                const reader = new CodeReader(this.boardConfig.codeRoot, undefined, diff.head);
                const output = await this.runEngine(id, {
                    thread: { id: review.id, engineSessionId: review.engineSessionId },
                    history,
                    text: prompt.text,
                    tools: reviewTools({
                        files: diff.files,
                        reader,
                        audited: (operation, query, run) =>
                            auditedRead(this.reads, { project: this.boardConfig.project, operation, subject, ...query }, run),
                        setTour: async tour => {
                            await this.reviews.setTour(review.id, tour);
                            publishReview(this.boardConfig.project, id, { event: 'tour', data: tour });
                        },
                    }),
                });

                await this.reviews.recordConversation(review.id, output.engineSessionId, prompt.commentsSeenId);
                const answer = await this.conversation.append(review.id, 'assistant', output.text.trim() || '(no answer)', output.usage);
                publishReview(this.boardConfig.project, id, { event: 'done', data: { seq: answer.seq } });
                return answer;
            },
        );
    }

    /** The review a turn belongs to: the one at this commit, whose verdict a question doesn't disturb. */
    private async currentReview(id: string, diff: DiffSnapshot): Promise<StoredReview> {
        const latest = await this.reviews.latest(id);
        if (latest?.head === diff.head && (latest.status === 'open' || latest.status === 'approved')) return latest;
        return this.reviews.openAt(id, diff.head, diff.base);
    }

    private async promptFor(card: Card, review: StoredReview, diff: DiffSnapshot, isFirst: boolean, text: string, request: ReviewTurnRequest) {
        const id = card.frontmatter.id;
        const all = await this.comments.list(id);
        const unseen = all.filter(comment => comment.status === 'open' && BigInt(comment.id) > BigInt(review.commentsSeenId));
        const commentsSeenId = all.reduce((newest, comment) => (BigInt(comment.id) > BigInt(newest) ? comment.id : newest), review.commentsSeenId);

        let opening = '';
        if (isFirst) {
            const pin = card.frontmatter.planVersionId;
            opening = firstTurnBlock({
                cardId: id,
                title: card.frontmatter.title,
                plan: (pin ? await this.boardRepository.readAt(id, pin) : card).body,
                head: diff.head,
                base: diff.base,
                files: diff.files,
                learnings: await this.learnings.load(),
                sent: all.filter(comment => comment.status === 'sent'),
            });
        }
        const instruction = request.mode === 'tour' ? TOUR_INSTRUCTION : '';
        return { text: `${opening}${commentsBlock(unseen)}${instruction}${stepBlock(review.tour, request.stepIndex)}${text}`, commentsSeenId };
    }

    private async runEngine(id: string, turn: Pick<Parameters<CliChatEngine['turn']>[0], 'thread' | 'history' | 'text' | 'tools'>) {
        const project = this.boardConfig.project;
        const choice = await this.settings.get(CHAT_ENGINE);
        const { stages } = await this.stageConfigs.load();
        const laneModel = stages.find(stage => stage.name === REVIEW_STAGE)?.model;
        try {
            return await this.engine.turn({
                ...turn,
                system: reviewSystemPrompt(),
                provider: 'anthropic',
                // The lane's model when it names one. Otherwise the chat engine's: review always runs on the
                // 'cli' engine, which is only ever Claude, so a model chosen for another provider can't
                // be used here.
                model: laneModel ?? (choice.provider === 'anthropic' ? choice.model : DEFAULT_CHAT_ENGINE.model),
                maxSteps: MAX_REVIEW_STEPS,
                onlyOwnTools: true,
                onText: delta => publishReview(project, id, { event: 'delta', data: delta }),
            });
        } catch (err) {
            const reason = `the review agent could not answer: ${explainError(err)}`;
            this.logger.warn(`card ${id}: ${reason}`);
            publishReview(project, id, { event: 'failed', data: { reason } });
            throw httpError(503).withDetails({ reason });
        }
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
