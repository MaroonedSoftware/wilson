import { Kysely, sql } from 'kysely';
import type { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';

export type PlanTurnRole = 'user' | 'assistant';

export interface PlanTurn {
    seq: number;
    role: PlanTurnRole;
    content: string;
    engineSessionId: string | undefined;
    createdAt: DateTime;
}

/**
 * `wilson.plan_turns`, append-only — the record a later process (card 0132) appends a planning
 * turn to and replays from on `Last-Event-ID` reconnect. Follows `postgres.board.repository.ts`'s
 * shape: constructed with `BoardConfig` and the shared `Kysely<DB>` pool rather than resolved
 * through the container, the same way `PlanService` builds its own dependencies.
 *
 * Not `@Injectable()`: this class has no polymorphic swap the way `BoardRepository` does, and
 * every caller already holds the two constructor arguments, so `new` is simpler than a
 * registration this card's files in scope have nowhere in-scope to add (`board.module.ts` is not
 * one of them).
 */
export class PlanTurnRepository {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {}

    /**
     * Append one turn, assigning it the next `seq` for this card.
     *
     * `postgres.board.repository.ts`'s `writeIn` serializes writers by locking the row being
     * written, but a brand-new card has no row yet — a first turn is exactly the case `forUpdate`
     * cannot cover, since there is nothing to lock until after the seq it would protect is already
     * chosen. `pg_advisory_xact_lock`, keyed by hashing `project` and `cardId` into the two int4
     * key slots that overload takes, locks the *card* rather than a row, so it also covers the
     * first turn; it is released automatically when the transaction ends.
     */
    async append(cardId: string, role: PlanTurnRole, content: string, engineSessionId?: string): Promise<PlanTurn> {
        return this.db.transaction().execute(async trx => {
            await sql`select pg_advisory_xact_lock(hashtext(${this.config.project}), hashtext(${cardId}))`.execute(trx);

            const last = await trx
                .selectFrom('wilson.planTurns')
                .select('seq')
                .where('project', '=', this.config.project)
                .where('cardId', '=', cardId)
                .orderBy('seq', 'desc')
                .limit(1)
                .executeTakeFirst();
            const seq = (last?.seq ?? 0) + 1;

            const row = await trx
                .insertInto('wilson.planTurns')
                .values({
                    project: this.config.project,
                    cardId,
                    seq,
                    role,
                    content,
                    engineSessionId: engineSessionId ?? null,
                })
                .returning('createdAt')
                .executeTakeFirstOrThrow();

            return { seq, role, content, engineSessionId, createdAt: row.createdAt };
        });
    }

    /**
     * Every turn for a card with `seq` strictly greater than `afterSeq`, in order — what a fresh
     * client (`afterSeq` 0) or a reconnecting one (`afterSeq` its `Last-Event-ID`) is missing.
     */
    async since(cardId: string, afterSeq: number): Promise<PlanTurn[]> {
        const rows = await this.db
            .selectFrom('wilson.planTurns')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('seq', '>', afterSeq)
            .orderBy('seq')
            .execute();
        return rows.map(row => ({
            seq: row.seq,
            role: row.role as PlanTurnRole,
            content: row.content,
            engineSessionId: row.engineSessionId ?? undefined,
            createdAt: row.createdAt,
        }));
    }

    /**
     * The most recent engine session id recorded for a card, if any turn has one — what a session
     * rehydrated after a restart resumes rather than starting a fresh conversation. Not an error
     * for a card with no turns yet; there is simply nothing to resume.
     */
    async latestEngineSessionId(cardId: string): Promise<string | undefined> {
        const row = await this.db
            .selectFrom('wilson.planTurns')
            .select('engineSessionId')
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('engineSessionId', 'is not', null)
            .orderBy('seq', 'desc')
            .limit(1)
            .executeTakeFirst();
        return row?.engineSessionId ?? undefined;
    }
}
