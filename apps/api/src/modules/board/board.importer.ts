import { Injectable } from 'injectkit';
import { Kysely } from 'kysely';
import { Logger } from '@maroonedsoftware/logger';
import type { DB } from '#modules/data/db.js';
import { BoardConfig } from './board.config.js';
import { LegacyBoardFiles } from './legacy.board.files.js';
import type { Card } from './card.js';

export interface ImportReport {
    cards: number;
    dependencies: number;
    unpinned: string[];
    skipped: boolean;
}

/**
 * One-time import of a markdown board repo into Postgres.
 *
 * Ids are preserved exactly — `0018` stays `0018` — so branch names, commit messages and every
 * `dependsOn` written before the cut remain valid. Cards are inserted before dependencies because
 * `card_deps` has a foreign key in both directions: a dependency on a card that does not exist is
 * now refused by the database rather than absorbed by `nextCard`, which is the point of the table,
 * and it means insert order matters.
 *
 * The whole import is one transaction. A partial board is worse than no board: it would look
 * importable and dispatch a card whose dependencies were silently missing.
 */
@Injectable()
export class BoardImporter {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
        private readonly logger: Logger,
    ) {}

    /** Read the legacy board repo without touching it. */
    async readLegacyBoard(): Promise<Card[]> {
        return new LegacyBoardFiles(this.config, this.logger).list();
    }

    async import(cards: Card[], options: { dryRun: boolean } = { dryRun: false }): Promise<ImportReport> {
        const ids = new Set(cards.map(c => c.frontmatter.id));
        const dangling = cards.flatMap(c => c.frontmatter.dependsOn.filter(d => !ids.has(d)).map(d => `${c.frontmatter.id} -> ${d}`));
        if (dangling.length > 0) {
            throw new Error(`board has dependencies on cards that do not exist: ${dangling.join(', ')}`);
        }

        // A legacy `planSha` is a board-repo commit; there is no version row it can point at, and the
        // plan text at that commit is not recoverable from the current file. Pin to the imported
        // version instead and name the cards affected, so the operator can decide rather than
        // discovering a silently re-pinned plan later.
        const unpinned = cards.filter(c => c.frontmatter.planVersionId).map(c => c.frontmatter.id);

        const report: ImportReport = {
            cards: cards.length,
            dependencies: cards.reduce((n, c) => n + c.frontmatter.dependsOn.length, 0),
            unpinned,
            skipped: options.dryRun,
        };
        if (options.dryRun) return report;

        await this.db.transaction().execute(async trx => {
            const existing = await trx.selectFrom('runner.cards').select('id').where('project', '=', this.config.project).limit(1).executeTakeFirst();
            if (existing) {
                throw new Error(`project "${this.config.project}" already has cards; refusing to import over them`);
            }

            for (const card of cards) {
                const fm = card.frontmatter;
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
                    })
                    .execute();

                const version = await trx
                    .insertInto('runner.cardVersions')
                    .values({
                        project: this.config.project,
                        cardId: fm.id,
                        frontmatter: JSON.stringify(fm),
                        body: card.body,
                        message: `Imported ${fm.id} from the board repo`,
                    })
                    .returning('id')
                    .executeTakeFirstOrThrow();

                if (fm.planVersionId) {
                    await trx
                        .updateTable('runner.cards')
                        .set({ pinnedVersionId: version.id })
                        .where('project', '=', this.config.project)
                        .where('id', '=', fm.id)
                        .execute();
                }
            }

            const deps = cards.flatMap(c =>
                c.frontmatter.dependsOn.map(dependsOnId => ({ project: this.config.project, cardId: c.frontmatter.id, dependsOnId })),
            );
            if (deps.length > 0) {
                await trx.insertInto('runner.cardDeps').values(deps).execute();
            }
        });

        return report;
    }
}
