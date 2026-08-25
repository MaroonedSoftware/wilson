import { Injectable } from 'injectkit';
import { Kysely, type Transaction } from 'kysely';
import type { DB } from '#modules/data/db.js';
import { EventLog, type AppendableCardEvent } from '#modules/events/event.log.js';
import { BoardConfig } from './board.config.js';
import { BoardRepository, type CardVersionSummary } from './board.repository.js';
import { sectionsOf, type Card, type CardFrontmatter } from './card.js';

/** Either the pool or an open transaction; every read and write takes one so they can be composed. */
type Executor = Kysely<DB> | Transaction<DB>;

export class CardNotFoundError extends Error {}

/**
 * The board, in Postgres.
 *
 * `runner.cards` is current state and `runner.card_versions` is append-only history — the two roles
 * the board repo used to fill with a working tree and `git log`. A version snapshots frontmatter and
 * body together because `readAt` replaces `git show <sha>:<path>`, and the dispatcher reads
 * frontmatter from the pinned card, not just its plan text.
 *
 * Dependencies live in `runner.card_deps` rather than in a column, so a dependency on a card that
 * does not exist is refused by the database. `nextCard` still treats a missing dependency as
 * unfinished; that is now belt and braces rather than the only guard.
 */
@Injectable()
export class PostgresBoardRepository extends BoardRepository {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
        private readonly events: EventLog,
    ) {
        super();
    }

    async list(): Promise<Card[]> {
        const rows = await this.db
            .selectFrom('runner.cards')
            .selectAll()
            .where('project', '=', this.config.project)
            .orderBy('position')
            .orderBy('id')
            .execute();

        const deps = await this.db
            .selectFrom('runner.cardDeps')
            .select(['cardId', 'dependsOnId'])
            .where('project', '=', this.config.project)
            .orderBy('dependsOnId')
            .execute();

        const byCard = new Map<string, string[]>();
        for (const dep of deps) {
            byCard.set(dep.cardId, [...(byCard.get(dep.cardId) ?? []), dep.dependsOnId]);
        }
        return rows.map(row => toCard(row, byCard.get(row.id) ?? []));
    }

    async read(id: string): Promise<Card> {
        return this.readWith(this.db, id);
    }

    async readAt(id: string, version: string): Promise<Card> {
        const row = await this.db
            .selectFrom('runner.cardVersions')
            .select(['frontmatter', 'body'])
            .where('project', '=', this.config.project)
            .where('cardId', '=', id)
            .where('id', '=', version)
            .executeTakeFirst();
        if (!row) {
            throw new CardNotFoundError(`card ${id} has no version ${version}`);
        }
        const frontmatter = row.frontmatter as CardFrontmatter;
        return { frontmatter, sections: sectionsOf(row.body), body: row.body };
    }

    async currentVersion(id: string): Promise<string | undefined> {
        const row = await this.db
            .selectFrom('runner.cardVersions')
            .select('id')
            .where('project', '=', this.config.project)
            .where('cardId', '=', id)
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();
        return row === undefined ? undefined : versionId(row.id);
    }

    async versions(id: string, limit: number): Promise<CardVersionSummary[]> {
        const rows = await this.db
            .selectFrom('runner.cardVersions')
            .select(['id', 'message', 'createdAt'])
            .where('project', '=', this.config.project)
            .where('cardId', '=', id)
            .orderBy('id', 'desc')
            .limit(limit)
            .execute();
        return rows.map(row => ({ id: versionId(row.id), message: row.message, createdAt: row.createdAt }));
    }

    async write(id: string, message: string, mutate: (card: Card) => Card | Promise<Card>): Promise<string> {
        return this.db.transaction().execute(trx => this.writeIn(trx, id, message, mutate));
    }

    async writeWithEvent(id: string, message: string, mutate: (card: Card) => Card | Promise<Card>, event: AppendableCardEvent): Promise<string> {
        return this.db.transaction().execute(async trx => {
            const version = await this.writeIn(trx, id, message, mutate);
            await this.events.append(event, trx);
            return version;
        });
    }

    async create(card: Card, message: string): Promise<string> {
        return this.db.transaction().execute(async trx => {
            const fm = card.frontmatter;
            // No upsert: `create` means create. The file-backed implementation used `writeFile`,
            // which silently overwrote an existing card — a real card was destroyed that way.
            await trx
                .insertInto('runner.cards')
                .values({
                    project: this.config.project,
                    id: fm.id,
                    title: fm.title,
                    stage: fm.stage,
                    branch: fm.branch ?? null,
                    body: card.body,
                    retries: JSON.stringify(fm.retries ?? {}),
                    external: fm.external ? JSON.stringify(fm.external) : null,
                    sourceClosed: fm.sourceClosed ?? null,
                    needsHuman: fm.needsHuman ?? false,
                    needsHumanReason: fm.needsHumanReason ?? null,
                })
                .execute();
            await this.syncDeps(trx, fm.id, [], fm.dependsOn);
            return this.snapshot(trx, card, message);
        });
    }

    private async readWith(executor: Executor, id: string): Promise<Card> {
        const row = await executor
            .selectFrom('runner.cards')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('id', '=', id)
            .executeTakeFirst();
        if (!row) {
            throw new CardNotFoundError(`card ${id} does not exist`);
        }
        const deps = await executor
            .selectFrom('runner.cardDeps')
            .select('dependsOnId')
            .where('project', '=', this.config.project)
            .where('cardId', '=', id)
            .orderBy('dependsOnId')
            .execute();
        return toCard(
            row,
            deps.map(d => d.dependsOnId),
        );
    }

    /**
     * Read-modify-write inside one transaction.
     *
     * The row is locked for the duration, so the mutate callback sees the card as it is right now
     * rather than a copy the caller read earlier — the same guarantee the file implementation got
     * from an in-process mutex, except this one holds against every writer, not just this process.
     */
    private async writeIn(trx: Transaction<DB>, id: string, message: string, mutate: (card: Card) => Card | Promise<Card>): Promise<string> {
        await trx
            .selectFrom('runner.cards')
            .select('id')
            .where('project', '=', this.config.project)
            .where('id', '=', id)
            .forUpdate()
            .executeTakeFirst();

        const before = await this.readWith(trx, id);
        const after = await mutate(before);
        const fm = after.frontmatter;

        await trx
            .updateTable('runner.cards')
            .set({
                title: fm.title,
                stage: fm.stage,
                branch: fm.branch ?? null,
                body: after.body,
                retries: JSON.stringify(fm.retries ?? {}),
                external: fm.external ? JSON.stringify(fm.external) : null,
                sourceClosed: fm.sourceClosed ?? null,
                needsHuman: fm.needsHuman ?? false,
                needsHumanReason: fm.needsHumanReason ?? null,
                pinnedVersionId: fm.planVersionId ?? null,
                updatedAt: new Date().toISOString(),
            })
            .where('project', '=', this.config.project)
            .where('id', '=', id)
            .execute();

        await this.syncDeps(trx, id, before.frontmatter.dependsOn, fm.dependsOn);
        return this.snapshot(trx, after, message);
    }

    /** Append the version row and return its id. */
    private async snapshot(trx: Transaction<DB>, card: Card, message: string): Promise<string> {
        const row = await trx
            .insertInto('runner.cardVersions')
            .values({
                project: this.config.project,
                cardId: card.frontmatter.id,
                frontmatter: JSON.stringify(card.frontmatter),
                body: card.body,
                message,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
        return versionId(row.id);
    }

    private async syncDeps(trx: Transaction<DB>, cardId: string, before: string[], after: string[]): Promise<void> {
        const removed = before.filter(d => !after.includes(d));
        const added = after.filter(d => !before.includes(d));
        if (removed.length > 0) {
            await trx
                .deleteFrom('runner.cardDeps')
                .where('project', '=', this.config.project)
                .where('cardId', '=', cardId)
                .where('dependsOnId', 'in', removed)
                .execute();
        }
        if (added.length > 0) {
            await trx
                .insertInto('runner.cardDeps')
                .values(added.map(dependsOnId => ({ project: this.config.project, cardId, dependsOnId })))
                .execute();
        }
    }
}

/**
 * A version id as a string.
 *
 * `runner.card_versions.id` is `BIGSERIAL` and the driver hands back a JavaScript `BigInt`. `DB`
 * declares the column as `string` — hand-written database types cannot be checked against the
 * database, so TypeScript sees a string here and every caller believed one. The value survives being
 * logged, compared and stored, and then `JSON.stringify` throws `Do not know how to serialize a
 * BigInt` the first time it reaches an HTTP response, which is where `/api/cards/{id}/versions`
 * found it. `EventLog.tail` already did this conversion for the same reason; this is the rest of it.
 */
const versionId = (id: string): string => String(id);

const toCard = (
    row: {
        id: string;
        title: string;
        stage: string;
        branch: string | null;
        body: string;
        retries: unknown;
        external: unknown;
        sourceClosed: boolean | null;
        needsHuman: boolean;
        needsHumanReason: string | null;
        pinnedVersionId: string | null;
    },
    dependsOn: string[],
): Card => {
    const frontmatter: CardFrontmatter = {
        id: row.id,
        title: row.title,
        stage: row.stage,
        branch: row.branch ?? undefined,
        dependsOn,
        retries: (row.retries as Record<string, number> | null) ?? {},
        // `pinnedVersionId` is `runner.cards.pinned_version_id`, a BIGINT — the pg driver parses
        // BIGINT as a JS `BigInt`, same as `runner.card_versions.id` (see `versionId` below, and
        // `currentVersion`/`versions`, which already wrap it). This column went unconverted because
        // it was always null before card 0059 gave it a real value for the first time; left raw, the
        // very next `JSON.stringify(card.frontmatter)` — the next write to the card, in `snapshot` —
        // throws `Do not know how to serialize a BigInt`.
        planVersionId: row.pinnedVersionId ? versionId(row.pinnedVersionId) : undefined,
        external: (row.external as Record<string, string> | null) ?? undefined,
        sourceClosed: row.sourceClosed ?? undefined,
        needsHuman: row.needsHuman,
        needsHumanReason: row.needsHumanReason ?? undefined,
    };
    return { frontmatter, sections: sectionsOf(row.body), body: row.body };
};
