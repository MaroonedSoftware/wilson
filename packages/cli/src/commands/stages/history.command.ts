import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

interface HistoryOpts {
    limit?: number;
}

/** What changed about the project's lanes, newest first, or about one lane when it is named. */
const command: CommandModule<HistoryOpts> = {
    description: "Show the history of the project's lanes, newest first",
    args: [{ name: 'lane', description: 'One lane. Leave out for all of them' }],
    options: [{ flags: '--limit <n>', description: 'Maximum number of changes to show', type: 'number', default: 20 }],
    run: withApi<HistoryOpts>(async (opts, ctx, args, api) => {
        const lane = args[0] === undefined ? undefined : String(args[0]);
        const revisions = await api.stages.listLaneRevisions({ lane, limit: Number(opts.limit ?? 20) });
        if (revisions.length === 0) {
            ctx.logger.info('no lane changes');
            return 0;
        }

        for (const revision of revisions) {
            ctx.logger.info(`${revision.id}  ${revision.createdAt.toUTC().toISO()}  ${revision.lane ?? '(project)'}  ${revision.message}`);
        }
        return 0;
    }),
};

export default command;
