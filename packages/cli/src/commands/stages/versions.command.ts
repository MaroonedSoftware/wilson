import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

interface VersionsOpts {
    limit?: number;
}

/**
 * The stage config's history, newest first — what `git log config/stages.yaml` on the board repo
 * used to answer. Mirrors `wilson card versions`.
 */
const command: CommandModule<VersionsOpts> = {
    description: "Show the stage config's version history, newest first",
    options: [{ flags: '--limit <n>', description: 'Maximum number of versions to show', type: 'number', default: 20 }],
    run: withApi<VersionsOpts>(async (opts, ctx, _args, api) => {
        const versions = await api.stages.listStageConfigVersions({ limit: Number(opts.limit ?? 20) });
        if (versions.length === 0) {
            ctx.logger.info('no stage config versions');
            return 0;
        }

        for (const version of versions) {
            ctx.logger.info(`${version.id}  ${version.createdAt.toUTC().toISO()}  ${version.message}`);
        }
        return 0;
    }),
};

export default command;
