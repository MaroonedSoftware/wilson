import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { EventLog } from '#modules/events/event.log.js';
import { stageEnteredAt } from '#modules/events/time.in.stage.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { ActivityEvent, ActivityQuery, CardDiff, CardEvent, CardDetail, CardSummary, CardUsage, CardVersion, ListQuery, SplitPieceSummary } from '../../generated/board.js';
import { BoardConfig } from './board.config.js';
import { BoardRepository } from './board.repository.js';
import { CardNotFoundError } from './postgres.board.repository.js';
import { sectionKey, type Card } from './card.js';

/** `limit` when a caller omits it. */
const DEFAULT_HISTORY_LIMIT = 50;

/** Upper bound on `limit`, applied even when a caller asks for more. */
const MAX_HISTORY_LIMIT = 200;

const clampLimit = (limit: number | undefined): number => Math.min(limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);

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
    branch: card.frontmatter.branch,
    dependsOn: card.frontmatter.dependsOn,
    needsHuman: card.frontmatter.needsHuman ?? false,
    needsHumanReason: card.frontmatter.needsHumanReason,
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

    /** The cards split out of `id`, lowest id first; empty for a card that was never split. */
    private async piecesOf(id: string): Promise<SplitPieceSummary[]> {
        const cards = await this.boardRepository.list();
        return cards
            .filter(card => card.frontmatter.splitFrom === id)
            .map(({ frontmatter: { id, title, stage } }) => ({ id, title, stage }))
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    async list(): Promise<CardSummary[]> {
        const cards = await this.boardRepository.list();
        return Promise.all(cards.map(card => this.withStageEnteredAt(card, this.withResolvedBranch(card, toCardSummary(card)))));
    }

    async getById(id: string): Promise<CardDetail> {
        try {
            const card = await this.boardRepository.read(id);
            const detail = await this.withStageEnteredAt(card, this.withResolvedBranch(card, toCardDetail(card)));
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

        const branch = this.worktrees.resolveBranch(card);
        const result = await this.worktrees.patchSinceFork(branch, 'main');
        if (!result.ok) {
            throw httpError(400).withDetails({ reason: result.reason });
        }

        return { base: result.base, files: result.files, truncated: result.truncated };
    }
}
