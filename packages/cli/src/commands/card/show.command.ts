import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { DateTime } from 'luxon';
import { BoardRepository, EventLog, BoardConfig, filesInScope, timeInCurrentStage } from '@wilson/api/cli-bootstrap';

interface ShowOpts {
    json?: boolean;
}

const command: CommandModule<ShowOpts> = {
    description: 'Show a card: its state, its files in scope, and the tail of its event log',
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    options: [{ flags: '--json', description: 'Print the card state as a single JSON object', type: 'boolean' }],
    run: requireContainer<ShowOpts>(async (opts, ctx, args) => {
        const cardId = String(args[0]);
        const card = await ctx.container.get(BoardRepository).read(cardId);
        const fm = card.frontmatter;

        const events = await ctx.container.get(EventLog).tail(ctx.container.get(BoardConfig).project, cardId, 20);
        const timeInStage = timeInCurrentStage(events, DateTime.utc());

        if (opts.json) {
            const scope = filesInScope(card);
            ctx.logger.info(
                JSON.stringify(
                    {
                        id: fm.id,
                        title: fm.title,
                        stage: fm.stage,
                        branch: fm.branch ?? null,
                        planSha: fm.planSha ?? null,
                        dependsOn: fm.dependsOn,
                        filesInScope: scope,
                        secondsInStage: timeInStage ? timeInStage.as('seconds') : null,
                    },
                    null,
                    2,
                ),
            );
            return 0;
        }

        ctx.logger.info(`${fm.id}  ${fm.title}`);
        ctx.logger.info(`stage:    ${fm.stage}`);
        if (timeInStage) ctx.logger.info(`for:      ${timeInStage.shiftTo('days', 'hours', 'minutes').toHuman()}`);
        ctx.logger.info(`branch:   ${fm.branch ?? '—'}`);
        ctx.logger.info(`planSha:  ${fm.planSha ?? '— (not approved; stages run against the working copy)'}`);
        if (fm.dependsOn.length > 0) ctx.logger.info(`blocked:  ${fm.dependsOn.join(', ')}`);

        const scope = filesInScope(card);
        ctx.logger.info(`\nfiles in scope (${scope.length}):`);
        for (const glob of scope) ctx.logger.info(`  ${glob}`);

        if (events.length > 0) {
            ctx.logger.info('\nrecent events:');
            for (const event of events) {
                ctx.logger.info(`  ${event.createdAt.toISO()}  ${event.type}${event.stage ? ` (${event.stage})` : ''}`);
            }
        }
        return 0;
    }),
};

export default command;
