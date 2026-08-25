import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { EventLog } from '#modules/events/event.log.js';
import type { CardEvent, CardDetail, CardSummary, CardVersion, ListQuery } from '../../generated/board.js';
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
    ) {}

    async list(): Promise<CardSummary[]> {
        const cards = await this.boardRepository.list();
        return cards.map(toCardSummary);
    }

    async getById(id: string): Promise<CardDetail> {
        try {
            const card = await this.boardRepository.read(id);
            return toCardDetail(card);
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
}
