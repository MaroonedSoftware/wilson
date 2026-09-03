import { Injectable } from 'injectkit';
import { BoardRepository } from '#modules/board/board.repository.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import type { Card } from '#modules/board/card.js';
import type { CardSourceItem } from './card.source.js';

/**
 * Card 0203, split from [[0196]] (which carries the `CardSource` interface and registry this
 * consumes nothing from — see this card's Goal). Applies one item a `CardSource` reported: creates a
 * card in `parking-lot` carrying the external ref, or — when a card already carries that ref under
 * `source` — updates its title and body in place. Nothing calls this yet: the poll ([[0198]]) and
 * GitHub Issues ([[0199]]) are later cards, and a seam with no consumer is this card's intended end
 * state.
 *
 * Inbound authority only (PROJECT.md's "Card sources", decision 5). `CardSourceItem` — the only
 * shape a source can hand this — carries `externalId`, `title`, and `body`, and nothing else;
 * `apply`'s own signature adds only `source`, the key a ref is stored under in `cards.external`.
 * `stage`, `branch`, and `retries` are not reachable from any parameter this class takes — a shape a
 * source cannot say beats a check a source can fail (this card's Constraints).
 *
 * Both paths go through `BoardWriteService`, never `BoardRepository` directly (decision 3):
 * `createFromSource` for the first report of a ref, `rename`/`edit` — the same methods `PATCH
 * /api/cards/:id/rename` and `.../body` already use — for every report after. Reusing them rather
 * than writing a bespoke update is why this card adds only one new method to `BoardWriteService`
 * (`createFromSource`) instead of two.
 */
@Injectable()
export class InboundCardWriter {
    constructor(
        private readonly boardWriteService: BoardWriteService,
        private readonly boardRepository: BoardRepository,
    ) {}

    /** Apply one item `source` reported: create or update, whichever `item.externalId` resolves to. */
    async apply(source: string, item: CardSourceItem): Promise<void> {
        const existing = await this.findByExternalRef(source, item.externalId);

        if (!existing) {
            await this.boardWriteService.createFromSource(source, item.externalId, item.title, item.body);
            return;
        }

        await this.boardWriteService.rename(existing.frontmatter.id, { title: item.title });
        await this.boardWriteService.edit(existing.frontmatter.id, { body: item.body });
    }

    /**
     * The card already carrying `externalId` under `source` in its `cards.external`, if any.
     * `BoardRepository` has no ref-scoped query — adding one is outside this card's "Files in scope"
     * — so this is `list` plus a filter, the same best-effort full-board scan `BoardRepository.
     * scopeConflict` already accepts for a comparable lookup.
     */
    private async findByExternalRef(source: string, externalId: string): Promise<Card | undefined> {
        const cards = await this.boardRepository.list();
        return cards.find(card => card.frontmatter.external?.[source] === externalId);
    }
}
