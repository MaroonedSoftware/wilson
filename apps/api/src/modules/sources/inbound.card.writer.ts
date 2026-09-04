import { Injectable } from 'injectkit';
import { Duration } from 'luxon';
import { Logger } from '@maroonedsoftware/logger';
import { IdempotencyStore } from '@maroonedsoftware/cache';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import type { Card } from '#modules/board/card.js';
import type { CardSourceItem } from './card.source.js';

/**
 * How long a completed/dead idempotency marker is retained, replacing `IdempotencyStore`'s own
 * 24-hour default (sized for a webhook's redelivery window, which nothing here has). The failure mode
 * of too *short* a retention here is not incorrectness — a version that outlives it just gets
 * reprocessed once more, exactly the rare case this card exists to make rare, not to prevent
 * absolutely — so this only needs to comfortably clear `SOURCE_POLL_INTERVAL_MS_DEFAULT`
 * (`source.poll.interval.setting.ts`, five minutes) while still bounding `runner.cache_entries`'s
 * growth. Seven days does both: hundreds of poll intervals of headroom even for an operator-raised
 * interval measured in hours, and a table that only ever holds roughly a week of keys.
 */
const RETENTION_TTL = Duration.fromObject({ days: 7 });

/**
 * Card 0203, split from [[0196]] (which carries the `CardSource` interface and registry this
 * consumes nothing from — see this card's Goal). Applies one item a `CardSource` reported: creates a
 * card in `parking-lot` carrying the external ref, or — when a card already carries that ref under
 * `source` — updates its title and body in place. The poll ([[0198]]) and GitHub Issues ([[0199]])
 * are this class's callers.
 *
 * Inbound authority only (PROJECT.md's "Card sources", decision 5). `CardSourceItem` — the only
 * shape a source can hand this — carries `externalId`, `title`, `body`, and `version`, and nothing
 * else; `apply`'s own signature adds only `source`, the key a ref is stored under in `cards.external`.
 * `stage`, `branch`, and `retries` are not reachable from any parameter this class takes — a shape a
 * source cannot say beats a check a source can fail (this card's Constraints).
 *
 * Both paths go through `BoardWriteService`, never `BoardRepository` directly (decision 3):
 * `createFromSource` for the first report of a ref, `rename`/`edit` — the same methods `PATCH
 * /api/cards/:id/rename` and `.../body` already use — for every report after. Reusing them rather
 * than writing a bespoke update is why this card adds only one new method to `BoardWriteService`
 * (`createFromSource`) instead of two.
 *
 * Card 0197: the actual board write (`write`, below) is wrapped in `IdempotencyStore.deduplicate`, so
 * the same version of the same item reported twice — a webhook redelivery, or [[0198]]'s poll
 * reporting the same unedited issue on every later tick, since `since` is inclusive — is skipped
 * rather than performed again. Keyed by `${project}:${source}:${item.externalId}:${item.version}`,
 * composed here rather than passed in: `BoardConfig.project` is read ambiently for the same reason
 * `boardWriteService`/`boardRepository` already do.
 */
@Injectable()
export class InboundCardWriter {
    constructor(
        private readonly boardWriteService: BoardWriteService,
        private readonly boardRepository: BoardRepository,
        private readonly idempotencyStore: IdempotencyStore,
        private readonly boardConfig: BoardConfig,
        private readonly logger: Logger,
    ) {}

    /**
     * Apply one item `source` reported: create or update, whichever `item.externalId` resolves to —
     * at most once for a given `(source, externalId, version)`, whichever of `processed`/`duplicate`/
     * `dropped` `deduplicate` reports back. `duplicate` needs no handling here: it is the expected,
     * common case for an unedited item on every later tick, not an error. `dropped` — `write` has
     * failed `maxAttempts` times for this exact key — is logged the way a source refusal already is
     * (`SourcePoller.tickProject`) and otherwise swallowed: this must not throw and stop the caller's
     * walk over the rest of its own batch.
     */
    async apply(source: string, item: CardSourceItem): Promise<void> {
        const key = `${this.boardConfig.project}:${source}:${item.externalId}:${item.version}`;

        const outcome = await this.idempotencyStore.deduplicate(key, () => this.write(source, item), { retentionTtl: RETENTION_TTL });

        if (outcome.status === 'dropped') {
            this.logger.error(`inbound card write: dropped "${key}" after ${outcome.attempts} attempts`);
        }
    }

    private async write(source: string, item: CardSourceItem): Promise<void> {
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
