import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

interface ImportOpts {
    dryRun?: boolean;
}

/**
 * Import a markdown board repo into Postgres.
 *
 * One-time, and it refuses to run twice: a project that already has cards is left alone rather than
 * merged into, because a half-imported board looks importable and would dispatch a card whose
 * dependencies were silently missing. Reading the legacy board and refusing an empty or
 * already-imported one now happen behind `POST /api/board/import` (`BoardBootstrapService.import`,
 * card 0076), against whatever board repo the API itself is configured with.
 *
 * The board repo is only read. Keep it, archived, as the record of everything that happened before
 * the cut — but do not read from it again, and do not delete it.
 */
const command: CommandModule<ImportOpts> = {
    description: 'Import the legacy markdown board repo into Postgres (one-time)',
    options: [{ flags: '--dry-run', description: 'Report what would be imported without writing', type: 'boolean' }],
    run: withApi<ImportOpts>(async (opts, ctx, _args, api) => {
        const project = ctx.config.get('PROJECT_NAME', 'wilson');
        const report = await api.board.importLegacyBoard({ dryRun: opts.dryRun === true });

        ctx.logger.info(
            `${report.skipped ? 'would import' : 'imported'} ${report.cards} cards and ${report.dependencies} dependencies into project "${project}"`,
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
    }),
};

export default command;
