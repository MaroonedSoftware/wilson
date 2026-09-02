import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { DateTime } from 'luxon';
import { BoardRepository } from '#modules/board/board.repository.js';
import { CardNotFoundError } from '#modules/board/postgres.board.repository.js';
import type { AttachContextRequest, ContextSnapshot } from '../../generated/context.js';
import { CardContextRepository, type CardContext } from './card.context.repository.js';
import { ContextProviderRegistry } from './context.provider.registry.js';

/**
 * `fetchedBy` records the actor, not the provider — the vocabulary `transition.written` already
 * uses for `by` (`'human'` / `'runner'`). With no auth on this surface (card 0019) it is the only
 * honest value today: a card source would add its own when one exists, and the provider's identity
 * (derivable from the URL through `ContextProviderRegistry`) is a different fact this column does
 * not carry — a manifest field that means "who" for some rows and "what fetched it" for others
 * answers neither question later.
 */
const FETCHED_BY = 'human';

/**
 * `context.ck`'s service — the HTTP surface over `ContextProviderRegistry` and
 * `CardContextRepository`, joining the provider seam (card 0186) to the snapshot table (card 0185).
 *
 * Thin, following `StageConfigService`'s shape: the registry refuses, the provider refuses, and
 * this class's job is translating those into a 404 for a card that does not exist and a 400 whose
 * `details.reason` is the refusal's own sentence — never collapsed to one message, since a redirect,
 * a private address, a timeout, an oversized body, an upstream error and "no provider handles this
 * URL" are six different things [[0189]] has to render differently.
 *
 * Synchronous on purpose: attach has one caller, a human pasting a URL, and a fetch slow enough to
 * need a job is a fetch whose failure a person should see immediately, not learn about later.
 */
@Injectable()
export class ContextService {
    constructor(
        private readonly boardRepository: BoardRepository,
        private readonly contextRepository: CardContextRepository,
        private readonly providers: ContextProviderRegistry,
    ) {}

    /**
     * Resolve `request.sourceUrl` through the registry, fetch it, and store what came back.
     * `fetchedAt` is a JS `Date` on `ContextFetchResult` (the only thing a `fetch` call returns) and
     * a Luxon `DateTime` on `CardContextRepository.attach` (what the `timestamptz` column needs) —
     * `DateTime.fromJSDate` here is that conversion, done exactly once, at this boundary. The
     * `contentHash` the provider computed is passed through unchanged; it is the only thing that
     * ever held the raw bytes, so recomputing it here would be redundant at best.
     */
    async attach(id: string, request: AttachContextRequest): Promise<ContextSnapshot> {
        await this.readOrThrow(id);

        const resolution = this.providers.resolve(request.sourceUrl);
        if (!resolution.ok) {
            throw httpError(400).withDetails({ reason: resolution.reason });
        }

        const fetched = await resolution.provider.fetch(request.sourceUrl);
        if (!fetched.ok) {
            throw httpError(400).withDetails({ reason: fetched.reason });
        }

        const snapshot = await this.contextRepository.attach(
            id,
            request.sourceUrl,
            DateTime.fromJSDate(fetched.fetchedAt),
            FETCHED_BY,
            fetched.title,
            fetched.content,
            fetched.contentHash,
        );
        return toGenerated(snapshot);
    }

    /** A card's context snapshots, oldest first. */
    async list(id: string): Promise<ContextSnapshot[]> {
        await this.readOrThrow(id);
        return (await this.contextRepository.list(id)).map(toGenerated);
    }

    /**
     * Remove one snapshot. 404 for either half of the path being wrong — a card id that does not
     * exist, or a snapshot id that does not exist or belongs to a different card — the same shape of
     * miss `board.ck`'s `.../plan/comments/{commentId}/resolve` answers.
     */
    async remove(id: string, contextId: string): Promise<void> {
        await this.readOrThrow(id);
        const deleted = await this.contextRepository.remove(id, contextId);
        if (!deleted) throw httpError(404);
    }

    private async readOrThrow(id: string): Promise<void> {
        try {
            await this.boardRepository.read(id);
        } catch (err) {
            if (err instanceof CardNotFoundError) throw httpError(404);
            throw err;
        }
    }
}

function toGenerated(context: CardContext): ContextSnapshot {
    return {
        id: context.id,
        sourceUrl: context.sourceUrl,
        fetchedAt: context.fetchedAt,
        fetchedBy: context.fetchedBy,
        title: context.title,
        content: context.content,
        contentHash: context.contentHash,
        createdAt: context.createdAt,
    };
}
