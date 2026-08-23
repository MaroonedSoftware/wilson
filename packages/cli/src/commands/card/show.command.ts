import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardRepository, EventLog, BoardConfig, filesInScope } from '@kanban/api/cli-bootstrap';

const command: CommandModule = {
    description: 'Show a card: its state, its files in scope, and the tail of its event log',
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: requireContainer(async (_opts, ctx, args) => {
        const cardId = String(args[0]);
        const card = await ctx.container.get(BoardRepository).read(cardId);
        const fm = card.frontmatter;

        ctx.logger.info(`${fm.id}  ${fm.title}`);
        ctx.logger.info(`stage:    ${fm.stage}`);
        ctx.logger.info(`branch:   ${fm.branch ?? '—'}`);
        ctx.logger.info(`planSha:  ${fm.planSha ?? '— (not approved; stages run against the working copy)'}`);
        if (fm.dependsOn.length > 0) ctx.logger.info(`blocked:  ${fm.dependsOn.join(', ')}`);

        const scope = filesInScope(card);
        ctx.logger.info(`\nfiles in scope (${scope.length}):`);
        for (const glob of scope) ctx.logger.info(`  ${glob}`);

        const events = await ctx.container.get(EventLog).tail(ctx.container.get(BoardConfig).project, cardId, 20);
        if (events.length > 0) {
            ctx.logger.info('\nrecent events:');
            for (const event of events) {
                ctx.logger.info(`  ${event.createdAt.toISOString()}  ${event.type}${event.stage ? ` (${event.stage})` : ''}`);
            }
        }
        return 0;
    }),
};

export default command;
