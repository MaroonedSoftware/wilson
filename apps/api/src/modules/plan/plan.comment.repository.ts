import { Kysely } from 'kysely';
import type { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';

export interface PlanComment {
    id: string;
    quote: string;
    prefix: string;
    suffix: string;
    text: string;
    resolved: boolean;
    createdAt: DateTime;
}

/**
 * `wilson.plan_comments` — a comment left on a passage of a plan draft. Follows
 * `postgres.board.repository.ts`'s shape the same way `PlanTurnRepository` does: constructed with
 * `BoardConfig` and the shared `Kysely<DB>` pool rather than resolved through the container.
 *
 * Not `@Injectable()`, for the same reason `PlanTurnRepository` is not — no polymorphic swap, and
 * every caller already holds the two constructor arguments, so `new` (in `PlanService`) is
 * simpler than a registration this card's files in scope have nowhere to add.
 *
 * Stores exactly the anchor [[0145]]'s `Anchor` captures — `quote`, `prefix`, `suffix` — and
 * never a resolved position: whether a quote still locates in the current draft is a read-time
 * question `locateAnchor` (apps/web/src/lib/anchor.ts) answers, not something this repository
 * precomputes or stores.
 */
export class PlanCommentRepository {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {}

    /** Record a new, open comment on a card's plan draft. */
    async append(cardId: string, quote: string, prefix: string, suffix: string, text: string): Promise<PlanComment> {
        const row = await this.db
            .insertInto('wilson.planComments')
            .values({
                project: this.config.project,
                cardId,
                quote,
                prefix,
                suffix,
                text,
                resolved: false,
            })
            .returning(['id', 'createdAt'])
            .executeTakeFirstOrThrow();

        return { id: String(row.id), quote, prefix, suffix, text, resolved: false, createdAt: row.createdAt };
    }

    /** Every comment on a card, open and resolved alike, oldest first. */
    async list(cardId: string): Promise<PlanComment[]> {
        const rows = await this.db
            .selectFrom('wilson.planComments')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .orderBy('id')
            .execute();
        return rows.map(toPlanComment);
    }

    /**
     * A card's open comments, oldest first — what `PlanService.turn` prepends to the agent's next
     * prompt. Never a resolved one: resolved comments stay on record but are not this card's
     * business to keep re-raising with the agent.
     */
    async open(cardId: string): Promise<PlanComment[]> {
        const rows = await this.db
            .selectFrom('wilson.planComments')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('resolved', '=', false)
            .orderBy('id')
            .execute();
        return rows.map(toPlanComment);
    }

    /**
     * Mark one comment resolved. Resolving does not delete it — "which comments are open" is the
     * question `open` asks; "what was said" stays answerable from `list` after this. `undefined`
     * for a comment id that does not exist, or does not belong to this card.
     */
    async resolve(cardId: string, id: string): Promise<PlanComment | undefined> {
        const row = await this.db
            .updateTable('wilson.planComments')
            .set({ resolved: true })
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirst();
        return row ? toPlanComment(row) : undefined;
    }
}

function toPlanComment(row: {
    id: string;
    quote: string;
    prefix: string;
    suffix: string;
    text: string;
    resolved: boolean;
    createdAt: DateTime;
}): PlanComment {
    return {
        id: String(row.id),
        quote: row.quote,
        prefix: row.prefix,
        suffix: row.suffix,
        text: row.text,
        resolved: row.resolved,
        createdAt: row.createdAt,
    };
}
