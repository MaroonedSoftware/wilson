import { Injectable } from 'injectkit';
import { BoardService } from '#modules/board/board.service.js';
import { StagesService } from '#modules/stages/stages.service.js';
import type {
    ActivityEvent,
    CardBlocked,
    CardDetail,
    CardSummary,
    MergeStatus,
    ProjectStats,
    ProjectStatsCounts,
    SplitPieceSummary,
} from '../../generated/board.js';
import type {
    AppV1ActivityEvent,
    AppV1ActivityQuery,
    AppV1BoardColumns,
    AppV1Card,
    AppV1CardBlocked,
    AppV1CardDetail,
    AppV1MergeStatus,
    AppV1SplitPiece,
    AppV1Stats,
    AppV1StatsCounts,
    AppV1StatsQuery,
} from '../../generated/app.api.js';

/** The object without its unset keys, so an optional field is absent rather than present and undefined. */
const defined = <T extends object>(value: { [K in keyof T]: T[K] | undefined }): T =>
    Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;

const toMergeStatus = (status: MergeStatus): AppV1MergeStatus =>
    defined<AppV1MergeStatus>({
        state: status.state,
        target: status.target,
        conflicts: status.conflicts,
        movedUnder: status.movedUnder,
        reason: status.reason,
    });

/** Leaves out `patchPath`, which is a path on the server and no use to anything in a browser. */
const toBlocked = (blocked: CardBlocked): AppV1CardBlocked =>
    defined<AppV1CardBlocked>({
        category: blocked.category,
        tried: blocked.tried,
        question: blocked.question,
        options: blocked.options,
        stage: blocked.stage,
        askedAt: blocked.askedAt,
    });

const toCard = (card: CardSummary): AppV1Card =>
    defined<AppV1Card>({
        id: card.id,
        title: card.title,
        stage: card.stage,
        doneReason: card.doneReason,
        planCheck: card.planCheck,
        planCheckReason: card.planCheckReason,
        branch: card.resolvedBranch ?? card.branch,
        dependsOn: card.dependsOn,
        needsHuman: card.needsHuman,
        needsHumanReason: card.needsHumanReason,
        blocked: card.blocked && toBlocked(card.blocked),
        position: card.position,
        splitFrom: card.splitFrom,
        stageEnteredAt: card.stageEnteredAt,
        mergeStatus: card.mergeStatus && toMergeStatus(card.mergeStatus),
    });

const toPiece = (piece: SplitPieceSummary): AppV1SplitPiece =>
    defined<AppV1SplitPiece>({ id: piece.id, title: piece.title, stage: piece.stage, doneReason: piece.doneReason });

const toCardDetail = (card: CardDetail): AppV1CardDetail =>
    defined<AppV1CardDetail>({ ...toCard(card), body: card.body, sections: card.sections, pieces: card.pieces?.map(toPiece) });

/** Leaves out `payload`, whose shape is the event log's. An app that wants the detail opens the card. */
const toActivityEvent = (event: ActivityEvent): AppV1ActivityEvent => ({
    id: event.id,
    cardId: event.cardId,
    cardTitle: event.cardTitle,
    type: event.type,
    stage: event.stage,
    createdAt: event.createdAt,
});

const toCounts = (counts: ProjectStatsCounts): AppV1StatsCounts => ({
    attempts: counts.attempts,
    passed: counts.passed,
    failed: counts.failed,
    interrupted: counts.interrupted,
    inputTokens: counts.inputTokens,
    cachedInputTokens: counts.cachedInputTokens,
    outputTokens: counts.outputTokens,
});

const toStats = (stats: ProjectStats): AppV1Stats => ({
    since: stats.since,
    until: stats.until,
    zone: stats.zone,
    total: { ...toCounts(stats.total), cards: stats.total.cards },
    stages: stats.stages.map(row => ({ ...toCounts(row), stage: row.stage, cards: row.cards })),
    days: stats.days.map(row => ({ ...toCounts(row), date: row.date })),
    topCards: stats.topCards.map(row => defined({ ...toCounts(row), cardId: row.cardId, cardTitle: row.cardTitle })),
    conversations: stats.conversations.map(row => ({
        kind: row.kind,
        turns: row.turns,
        cards: row.cards,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        outputTokens: row.outputTokens,
    })),
});

/**
 * What operator apps read (`app.api.ck`). Every field is copied by name, because the routers send whatever
 * a service returns: spreading a board row here would hand apps each field the board gains later, under a
 * grant nobody gave for it, and the contract would not notice.
 */
@Injectable()
export class AppApiService {
    constructor(
        private readonly board: BoardService,
        private readonly stages: StagesService,
    ) {}

    async listCards(): Promise<AppV1Card[]> {
        return (await this.board.list()).map(toCard);
    }

    async getCard(id: string): Promise<AppV1CardDetail> {
        return toCardDetail(await this.board.getById(id));
    }

    async listBoardColumns(): Promise<AppV1BoardColumns> {
        const { stages, nonStages } = await this.stages.columns();
        return { stages, nonStages };
    }

    async listProjectActivity(query: AppV1ActivityQuery): Promise<AppV1ActivityEvent[]> {
        return (await this.board.activity(query)).map(toActivityEvent);
    }

    async getProjectStats(query: AppV1StatsQuery): Promise<AppV1Stats> {
        return toStats(await this.board.stats(query));
    }
}
