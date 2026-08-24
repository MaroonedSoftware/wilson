import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardConfig, BoardImporter } from '@wilson/api/cli-bootstrap';

interface ImportOpts {
    dryRun?: boolean;
}

/**
 * Import a markdown board repo into Postgres.
 *
 * One-time, and it refuses to run twice: a project that already has cards is left alone rather than
 * merged into, because a half-imported board looks importable and would dispatch a card whose
 * dependencies were silently missing.
 *
 * The board repo is only read. Keep it, archived, as the record of everything that happened before
 * the cut — but do not read from it again, and do not delete it.
 */
const command: CommandModule<ImportOpts> = {
    description: 'Import the legacy markdown board repo into Postgres (one-time)',
    options: [{ flags: '--dry-run', description: 'Report what would be imported without writing', type: 'boolean' }],
    run: requireContainer<ImportOpts>(async (opts, ctx) => {
        const config = ctx.container.get(BoardConfig);
        const importer = ctx.container.get(BoardImporter);

        const cards = await importer.readLegacyBoard();
        if (cards.length === 0) {
            ctx.logger.error(`no cards found under ${config.boardRoot}/cards`);
            return 1;
        }

        try {
            const report = await importer.import(cards, { dryRun: opts.dryRun === true });

            ctx.logger.info(
                `${report.skipped ? 'would import' : 'imported'} ${report.cards} cards and ${report.dependencies} dependencies into project "${config.project}"`,
            );
            for (const id of report.unpinned) {
                ctx.logger.warn(
                    `${id} was pinned to a board-repo commit; its plan text at that commit is not recoverable, so it is now pinned to the imported version`,
                );
            }
            if (report.skipped) {
                ctx.logger.info('dry run — nothing written');
            }
            return 0;
        } catch (err) {
            ctx.logger.error((err as Error).message);
            return 1;
        }
    }),
};

export default command;
