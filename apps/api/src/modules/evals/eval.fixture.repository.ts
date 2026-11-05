import { Injectable } from 'injectkit';
import { Kysely, type Selectable } from 'kysely';
import type { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import type { DB, Json, WilsonEvalFixtures } from '#modules/data/db.js';
import type { AttemptEvent, EvalExpected } from './eval.attempt.js';

/** The events an attempt can be found from. A stage writes tool events by the hundred; these it does not. */
const ATTEMPT_EVENT_TYPES = ['stage.dispatched', 'stage.passed', 'stage.failed', 'worktree.created', 'work.committed'];

/** One stored fixture: a past attempt's plan and starting tree. */
export interface EvalFixtureRow {
    id: string;
    sourceCardId: string;
    stage: string;
    sourceEventId: string;
    planVersionId: string;
    plan: Card;
    baseSha: string;
    headSha: string;
    expected?: EvalExpected;
    createdAt: DateTime;
}

export type NewEvalFixture = Omit<EvalFixtureRow, 'id' | 'createdAt'>;

const toRow = (row: Selectable<WilsonEvalFixtures>): EvalFixtureRow => ({
    id: String(row.id),
    sourceCardId: row.sourceCardId,
    stage: row.stage,
    sourceEventId: String(row.sourceEventId),
    planVersionId: row.planVersionId,
    plan: row.plan as unknown as Card,
    baseSha: row.baseSha,
    headSha: row.headSha,
    ...(row.expected ? { expected: row.expected as unknown as EvalExpected } : {}),
    createdAt: row.createdAt,
});

/** `wilson.eval_fixtures`, and the reads of a card's history capturing one needs. Per project. */
@Injectable()
export class EvalFixtureRepository {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {}

    /** A card's attempt-shaping events, oldest first. */
    async attemptEvents(cardId: string): Promise<(AttemptEvent & { createdAt: DateTime })[]> {
        const rows = await this.db
            .selectFrom('wilson.cardEvents')
            .select(['id', 'stage', 'type', 'payload', 'createdAt'])
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('type', 'in', ATTEMPT_EVENT_TYPES)
            .orderBy('id')
            .execute();
        return rows.map(row => ({
            id: String(row.id),
            stage: row.stage,
            type: row.type,
            payload: (row.payload ?? {}) as Record<string, unknown>,
            createdAt: row.createdAt,
        }));
    }

    /**
     * The version a card's plan was pinned to at `at`, from the newest version written by then: every
     * version keeps the pin it had. Falls back to that version itself for a card with no pin, which is
     * what a stage reads in that case.
     */
    async pinnedVersionAt(cardId: string, at: DateTime): Promise<string | undefined> {
        const row = await this.db
            .selectFrom('wilson.cardVersions')
            .select(['id', 'frontmatter'])
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('createdAt', '<=', at)
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();
        if (!row) return undefined;
        const pinned = (row.frontmatter as { planVersionId?: unknown } | null)?.planVersionId;
        return typeof pinned === 'string' ? pinned : String(row.id);
    }

    /** Answers `undefined` when this attempt is already a fixture. */
    async insert(fixture: NewEvalFixture): Promise<EvalFixtureRow | undefined> {
        const row = await this.db
            .insertInto('wilson.evalFixtures')
            .values({
                project: this.config.project,
                sourceCardId: fixture.sourceCardId,
                stage: fixture.stage,
                sourceEventId: BigInt(fixture.sourceEventId),
                planVersionId: fixture.planVersionId,
                plan: JSON.stringify(fixture.plan) as unknown as Json,
                baseSha: fixture.baseSha,
                headSha: fixture.headSha,
                expected: fixture.expected ? (JSON.stringify(fixture.expected) as unknown as Json) : null,
            })
            .onConflict(conflict => conflict.columns(['project', 'sourceEventId']).doNothing())
            .returningAll()
            .executeTakeFirst();
        return row ? toRow(row) : undefined;
    }

    async list(): Promise<EvalFixtureRow[]> {
        const rows = await this.db.selectFrom('wilson.evalFixtures').selectAll().where('project', '=', this.config.project).orderBy('id').execute();
        return rows.map(toRow);
    }

    async find(id: string): Promise<EvalFixtureRow | undefined> {
        const row = await this.db
            .selectFrom('wilson.evalFixtures')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('id', '=', BigInt(id))
            .executeTakeFirst();
        return row ? toRow(row) : undefined;
    }

    async setExpected(id: string, expected: EvalExpected): Promise<void> {
        await this.db
            .updateTable('wilson.evalFixtures')
            .set({ expected: JSON.stringify(expected) as unknown as Json })
            .where('project', '=', this.config.project)
            .where('id', '=', BigInt(id))
            .execute();
    }

    async remove(id: string): Promise<void> {
        await this.db.deleteFrom('wilson.evalFixtures').where('project', '=', this.config.project).where('id', '=', BigInt(id)).execute();
    }
}
