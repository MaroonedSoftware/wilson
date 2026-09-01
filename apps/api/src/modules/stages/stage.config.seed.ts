import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@maroonedsoftware/logger';
import type { ProjectRow } from '#modules/board/project.repository.js';
import type { StageConfigStore } from './stage.config.store.js';

/**
 * One-time import of a project's `config/stages.yaml` from its board repo into `runner.stage_configs`.
 *
 * The cutover from file to row must not need a hand step on the deployment that already has a
 * file: the first boot after this change finds no row for the project, reads the file the previous
 * boot was reading, and stores it verbatim — comments, the operator's uncommitted edit, everything.
 * From then on the row wins outright and the file is never read again, the same rule
 * `resolveProjectRow` (board.module.ts) applies to `runner.projects` and the environment: the file
 * seeds once, and an operator who edits it afterwards gets the row's value, not the file's.
 *
 * A project with a row is left alone. A project with neither a row nor a file gets a warning and
 * nothing else — `wilson board init` scaffolds a default config for it. A file that does not
 * validate is not imported either: `StageConfigStore.save` refuses what `load` could not read, and
 * a warning naming the reason is the same signal a broken `stages.yaml` used to give on the next
 * dispatch, one boot earlier. Fix the file and restart, or `wilson stages set` the fixed one.
 *
 * Transitional, like `BoardImporter` was for cards: it exists to carry existing deployments over,
 * and goes when `boardRoot` does.
 */
export const seedStageConfigFromBoardRepo = async (store: StageConfigStore, row: ProjectRow, logger: Logger): Promise<void> => {
    if (await store.read()) return;

    const path = join(row.boardRoot, 'config', 'stages.yaml');
    const raw = await readFile(path, 'utf8').catch(() => undefined);
    if (raw === undefined) {
        logger.warn(`project "${row.name}" has no stage config and no ${path} to import it from; run \`wilson board init\``);
        return;
    }

    try {
        await store.save(raw, `Imported from ${path}`);
        logger.info(`imported stage config for "${row.name}" from ${path}`);
    } catch (err) {
        logger.warn(`stage config for "${row.name}" not imported from ${path}: ${(err as Error).message}`);
    }
};
