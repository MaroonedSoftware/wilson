import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardRepository } from '@wilson/api/cli-bootstrap';

interface VersionsOpts {
    limit?: number;
}

const command: CommandModule<VersionsOpts> = {
    description: "Show a card's version history, newest first",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    options: [{ flags: '--limit <n>', description: 'Maximum number of versions to show', type: 'number', default: 20 }],
    run: requireContainer<VersionsOpts>(async (opts, ctx, args) => {
        const cardId = String(args[0]);
        const limit = Number(opts.limit ?? 20);

        const versions = await ctx.container.get(BoardRepository).versions(cardId, limit);
        if (versions.length === 0) {
            ctx.logger.info(`${cardId} has no versions`);
            return 0;
        }

        for (const version of versions) {
            ctx.logger.info(`${version.id}  ${version.createdAt.toISO()}  ${version.message}`);
        }
        return 0;
    }),
};

export default command;
