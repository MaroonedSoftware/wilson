import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { DateTime } from 'luxon';
import { EventLog } from '#modules/events/event.log.js';
import { stageEnteredAt } from '#modules/events/time.in.stage.js';
import { CardBranchDiffSource } from '#modules/review/review.diff.source.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type {
    ActivityEvent,
    ActivityQuery,
    CardDiff,
    CardEvent,
    CardDetail,
    CardPlan,
    CardPlanQuery,
    CardSummary,
    CardTimeline,
    CardUsage,
    CardVersion,
    ListQuery,
    ProjectGateStats,
    ProjectStats,
    ProjectStatsQuery,
    SplitPieceSummary,
} from '../../generated/board.js';
import { BoardConfig } from './board.config.js';
import { BoardRepository } from './board.repository.js';
import { MergeStatusReader } from './merge.status.reader.js';
import { RE_REVIEW_RETRY_KEY } from './re.review.js';
import { CardNotFoundError } from './postgres.board.repository.js';
import { acceptanceCriteria, PLAN_SECTIONS, sectionKey, type Card } from './card.js';

/** `limit` when a caller omits it. */
const DEFAULT_HISTORY_LIMIT = 50;

/** Upper bound on `limit`, applied even when a caller asks for more. */
const MAX_HISTORY_LIMIT = 200;

const clampLimit = (limit: number | undefined): number => Math.min(limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);

/** `days` when a caller omits it. */
const DEFAULT_STATS_DAYS = 30;

/** Upper bound on `days`, applied even when a caller asks for more. */
const MAX_STATS_DAYS = 365;

/**
 * Card 0178. How far back {@link BoardService.withStageEnteredAt} looks for the transition that
 * answers `stageEnteredAt` — the same window `wilson card show` already fetches for the same
 * derivation (packages/cli/src/commands/card/show.command.ts). A stage that racks up more events
 * than this before its next transition (an agent's tool calls, mostly) pushes the transition out
 * of the window; `withStageEnteredAt` notices when that happened and answers `undefined` rather
 * than guessing from whatever the window's earliest event happens to be.
 */
const STAGE_ENTERED_LOOKBACK = 20;

/**
 * Exported so `BoardWriteService` can shape a card the same way after a write as this service does
 * after a read — one mapper describing a card on the wire, not two that can drift apart.
 */
export const toCardSummary = (card: Card): CardSummary => ({
    id: card.frontmatter.id,
    title: card.frontmatter.title,
    stage: card.frontmatter.stage,
    doneReason: card.frontmatter.doneReason as CardSummary['doneReason'],
    planCheck: card.frontmatter.planCheck,
    planCheckReason: card.frontmatter.planCheckReason,
    branch: card.frontmatter.branch,
    dependsOn: card.frontmatter.dependsOn,
    needsHuman: card.frontmatter.needsHuman ?? false,
    needsHumanReason: card.frontmatter.needsHumanReason,
    blocked: card.frontmatter.blocked && { ...card.frontmatter.blocked, askedAt: DateTime.fromISO(card.frontmatter.blocked.askedAt) },
    position: card.frontmatter.position,
    splitFrom: card.frontmatter.splitFrom,
});

export const toCardDetail = (card: Card): CardDetail => ({
    ...toCardSummary(card),
    body: card.body,
    sections: Object.fromEntries(
        Object.entries(card.sections)
            .filter((entry): entry is [string, string] => entry[1] !== undefined)
            .map(([section, text]) => [sectionKey(section as Parameters<typeof sectionKey>[0]), text]),
    ),
});

/**
 * The board's read surface — the service the generated `/api/cards*` router binds to.
 *
 * A thin translation layer over `BoardRepository` and `EventLog`: no read here does anything the
 * repository and the event log didn't already do for the CLI, this just shapes their results into
 * the contract's wire types and turns a missing card into a 404 instead of a 500.
 */
@Injectable()
export class BoardService {
    constructor(
        private readonly boardRepository: BoardRepository,
        private readonly eventLog: EventLog,
        private readonly boardConfig: BoardConfig,
        private readonly worktrees: WorktreeManager,
        // Optional so a test can build the service without one; unset, no card reports a merge status.
        private readonly mergeStatus?: MergeStatusReader,
    ) {}

    /**
     * Card 0160. Adds `resolvedBranch` on top of whatever `toCardSummary`/`toCardDetail` already
     * built — `WorktreeManager.resolveBranch` is the one place that answers "which branch is this
     * card's work on" (card 0095), and this is the only shape both `list` and `getById` need it
     * stitched onto.
     */
    private withResolvedBranch<T extends CardSummary>(card: Card, summary: T): T {
        return { ...summary, resolvedBranch: this.worktrees.resolveBranch(card) };
    }

    /**
     * Card 0178. Adds `stageEnteredAt` on top of whatever `toCardSummary`/`toCardDetail` already
     * built — the moment `card` entered its current stage, read from its own event tail and
     * derived the same way `wilson card show` derives it (`stageEnteredAt`, time.in.stage.ts).
     * Left absent when the fetched history has no events at all, rather than guessing.
     *
     * `eventLog.tail` returning fewer rows than `STAGE_ENTERED_LOOKBACK` asked for means there was
     * nothing more to fetch — this tail *is* the card's complete history, so `stageEnteredAt` can
     * trust the earliest row in it as the stage's start when no transition turns up. A full window
     * proves nothing either way: there could be exactly that many events, or there could be more
     * sitting before it that this fetch never reached — the same ambiguity `stageEnteredAt`'s
     * `fullHistory` option exists to resolve as "unknown" rather than "the window's earliest event".
     */
    private async withStageEnteredAt<T extends CardSummary>(card: Card, summary: T): Promise<T> {
        const events = await this.eventLog.tail(this.boardConfig.project, card.frontmatter.id, STAGE_ENTERED_LOOKBACK);
        const fullHistory = events.length < STAGE_ENTERED_LOOKBACK;
        return { ...summary, stageEnteredAt: stageEnteredAt(events, { fullHistory }) };
    }

    /** Adds `mergeStatus` to a card in `ready`, the one stage Merge acts on. */
    private async withMergeStatus<T extends CardSummary>(card: Card, summary: T): Promise<T> {
        if (!this.mergeStatus || card.frontmatter.stage !== 'ready') return summary;
        return {
            ...summary,
            mergeStatus: await this.mergeStatus.read(this.worktrees.resolveBranch(card), card.frontmatter.retries[RE_REVIEW_RETRY_KEY]),
        };
    }

    /** The cards split out of `id`, lowest id first; empty for a card that was never split. */
    private async piecesOf(id: string): Promise<SplitPieceSummary[]> {
        const cards = await this.boardRepository.list();
        return cards
            .filter(card => card.frontmatter.splitFrom === id)
            .map(({ frontmatter: { id, title, stage, doneReason } }) => ({
                id,
                title,
                stage,
                doneReason: doneReason as SplitPieceSummary['doneReason'],
            }))
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    async list(): Promise<CardSummary[]> {
        const cards = await this.boardRepository.list();
        return Promise.all(
            cards.map(async card =>
                this.withMergeStatus(card, await this.withStageEnteredAt(card, this.withResolvedBranch(card, toCardSummary(card)))),
            ),
        );
    }

    async getById(id: string): Promise<CardDetail> {
        try {
            const card = await this.boardRepository.read(id);
            const detail = await this.withMergeStatus(card, await this.withStageEnteredAt(card, this.withResolvedBranch(card, toCardDetail(card))));
            return { ...detail, pieces: await this.piecesOf(id) };
        } catch (err) {
            if (err instanceof CardNotFoundError) throw httpError(404);
            throw err;
        }
    }

    async events(id: string, query: ListQuery): Promise<CardEvent[]> {
        const rows = await this.eventLog.tail(this.boardConfig.project, id, clampLimit(query.limit));
        return rows.map(row => ({
            id: row.id,
            type: row.type,
            stage: row.stage,
            // The generated `json` scalar's TS type has no exported name to reference; indexing
            // into `CardEvent` reaches it without one. `EventLog.tail` already typed the column as
            // a plain object, so this is a relabeling, not a runtime check.
            payload: row.payload as unknown as CardEvent['payload'],
            createdAt: row.createdAt,
        }));
    }

    /**
     * A card's plan as a stage reads it. Pinned unless a caller asks for head, since the pin is what a
     * running stage and its verifier hold a card to: answering from head would explain a review
     * against text it never saw.
     */
    async plan(id: string, query: CardPlanQuery): Promise<CardPlan> {
        const head = await this.boardRepository.read(id).catch((err: unknown) => {
            if (err instanceof CardNotFoundError) throw httpError(404);
            throw err;
        });
        const pinnedVersion = head.frontmatter.planVersionId;
        const pinned = pinnedVersion ? await this.boardRepository.readAt(id, pinnedVersion) : undefined;
        const at = query.at ?? (pinned ? 'pinned' : 'head');
        const card = at === 'pinned' && pinned ? pinned : head;
        const currentVersion = await this.boardRepository.currentVersion(id);

        const sectionLengths: Record<string, number> = {};
        for (const section of PLAN_SECTIONS) {
            const text = card.sections[section];
            if (text !== undefined) sectionLengths[sectionKey(section)] = text.length;
        }
        const text = query.section ? card.sections[PLAN_SECTIONS.find(section => sectionKey(section) === query.section)!] : undefined;

        return {
            at: card === pinned ? 'pinned' : 'head',
            version: card === pinned ? pinnedVersion : currentVersion,
            currentVersion,
            pinnedVersion,
            differsFromPin: pinned !== undefined && pinned.body !== head.body,
            sectionLengths,
            text,
            criteria: acceptanceCriteria(card),
        };
    }

    async versions(id: string, query: ListQuery): Promise<CardVersion[]> {
        return this.boardRepository.versions(id, clampLimit(query.limit));
    }

    /**
     * Card 0263. What `id` has cost, per stage and in total — `EventLog.usageByStage`'s own doc
     * comment has the shape and why it is tokens, not dollars. The 404 here is "no such card", the
     * same guard `getById` makes; a card that exists but has never run a stage is not that — it gets
     * `usageByStage`'s zeros in an ordinary 200, same as `events` returns an empty array rather than
     * refusing a card with no history yet.
     */
    async activity(query: ActivityQuery): Promise<ActivityEvent[]> {
        const rows = await this.eventLog.recent(this.boardConfig.project, clampLimit(query.limit), query.before);
        return rows.map(row => ({
            id: row.id,
            cardId: row.cardId,
            cardTitle: row.cardTitle ?? null,
            type: row.type,
            stage: row.stage,
            payload: row.payload as unknown as ActivityEvent['payload'],
            createdAt: row.createdAt,
        }));
    }

    async timeline(id: string): Promise<CardTimeline> {
        try {
            await this.boardRepository.read(id);
        } catch (err) {
            if (err instanceof CardNotFoundError) throw httpError(404);
            throw err;
        }
        return this.eventLog.timeline(this.boardConfig.project, id, DateTime.utc());
    }

    async usage(id: string): Promise<CardUsage> {
        try {
            await this.boardRepository.read(id);
        } catch (err) {
            if (err instanceof CardNotFoundError) throw httpError(404);
            throw err;
        }
        return this.eventLog.usageByStage(this.boardConfig.project, id);
    }

    /**
     * What the project spent over its last `days` days, today included. A day here starts at the
     * server's midnight, the same one the daily ceiling counts from.
     */
    async stats(query: ProjectStatsQuery): Promise<ProjectStats> {
        const { since, until } = this.statsWindow(query);
        return this.eventLog.projectStats(this.boardConfig.project, since, until);
    }

    /** What the gates caught and how often a person was pulled in, over the same window as {@link stats}. */
    async gateStats(query: ProjectStatsQuery): Promise<ProjectGateStats> {
        const { since, until } = this.statsWindow(query);
        return this.eventLog.gateStats(this.boardConfig.project, since, until);
    }

    private statsWindow(query: ProjectStatsQuery): { since: DateTime; until: DateTime } {
        const days = Math.max(1, Math.min(query.days ?? DEFAULT_STATS_DAYS, MAX_STATS_DAYS));
        const now = DateTime.now();
        return {
            since: now.startOf('day').minus({ days: days - 1 }),
            // Past the current instant, so an event written in the same millisecond is not left out.
            until: now.plus({ seconds: 1 }),
        };
    }

    /**
     * Card 0265. `ready`'s human gate, read without a terminal: the card's branch diffed against
     * `merge-base(main, branch)`, the same range `wilson card diff` already uses
     * (`WorktreeManager.patchSinceFork`'s own doc comment has the reasoning). The 404 here is "no
     * such card", the same guard `getById` makes; the 400 is `patchSinceFork`'s own refusal — a
     * card whose branch has never been cut — carried through unchanged rather than re-derived here.
     */
    async diff(id: string): Promise<CardDiff> {
        let card: Card;
        try {
            card = await this.boardRepository.read(id);
        } catch (err) {
            if (err instanceof CardNotFoundError) throw httpError(404);
            throw err;
        }

        const result = await new CardBranchDiffSource(this.worktrees).read(card);
        if (!result.ok) {
            throw httpError(400).withDetails({ reason: result.reason });
        }

        return { base: result.base, files: result.files, truncated: result.truncated };
    }
}
