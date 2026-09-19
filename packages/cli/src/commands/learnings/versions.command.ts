import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

interface VersionsOpts {
    limit?: number;
}

/**
 * The learnings document's history, newest first — what `git log` on a committed learnings file
 * would have answered. Mirrors `wilson stages versions`.
 */
const command: CommandModule<VersionsOpts> = {
    description: "Show the learnings document's version history, newest first",
    options: [{ flags: '--limit <n>', description: 'Maximum number of versions to show', type: 'number', default: 20 }],
    run: withApi<VersionsOpts>(async (opts, ctx, _args, api) => {
        const versions = await api.learnings.listLearningsVersions({ limit: Number(opts.limit ?? 20) });
        if (versions.length === 0) {
            ctx.logger.info('no learnings versions');
            return 0;
        }

        for (const version of versions) {
            ctx.logger.info(`${version.id}  ${version.createdAt}  ${version.message}`);
        }
        return 0;
    }),
};

export default command;
