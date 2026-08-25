import type { CommandModule } from '@maroonedsoftware/johnny5';
import { DateTime } from 'luxon';
import { withApi } from '../../api-client.js';
import { filesInScope, timeInCurrentStage } from '../../board-view.js';

interface ShowOpts {
    json?: boolean;
}

/**
 * `retries` and `planVersionId` are frontmatter fields the board API's wire contract does not
 * expose (`CardSummary`/`CardDetail` in `@wilson/sdk` — card 0080's contract). They dropped out of
 * this view along with the container it used to read them from; restoring them is a contract change
 * for a card of its own, not something a client can add back.
 */
const command: CommandModule<ShowOpts> = {
    description: 'Show a card: its state, its files in scope, and the tail of its event log',
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    options: [{ flags: '--json', description: 'Print the card state as a single JSON object', type: 'boolean' }],
    run: withApi<ShowOpts>(async (opts, ctx, args, api) => {
        const cardId = String(args[0]);
        const card = await api.board.getCard(cardId);

        const events = await api.board.listCardEvents(cardId, { limit: 20 });
        const timeInStage = timeInCurrentStage(events, DateTime.utc());

        if (opts.json) {
            const scope = filesInScope(card.sections);
            ctx.logger.info(
                JSON.stringify(
                    {
                        id: card.id,
                        title: card.title,
                        stage: card.stage,
                        branch: card.branch ?? null,
                        dependsOn: card.dependsOn,
                        filesInScope: scope,
                        secondsInStage: timeInStage ? timeInStage.as('seconds') : null,
                        needsHuman: card.needsHuman,
                        needsHumanReason: card.needsHumanReason ?? null,
                    },
                    null,
                    2,
                ),
            );
            return 0;
        }

        ctx.logger.info(`${card.id}  ${card.title}`);
        ctx.logger.info(`stage:    ${card.stage}`);
        if (timeInStage) ctx.logger.info(`for:      ${timeInStage.shiftTo('days', 'hours', 'minutes').toHuman()}`);
        ctx.logger.info(`branch:   ${card.branch ?? '—'}`);
        if (card.dependsOn.length > 0) ctx.logger.info(`blocked:  ${card.dependsOn.join(', ')}`);
        if (card.needsHuman) ctx.logger.info(`needs human: ${card.needsHumanReason ?? '(no reason given)'}`);

        const scope = filesInScope(card.sections);
        ctx.logger.info(`\nfiles in scope (${scope.length}):`);
        for (const glob of scope) ctx.logger.info(`  ${glob}`);

        if (events.length > 0) {
            ctx.logger.info('\nrecent events:');
            for (const event of events) {
                ctx.logger.info(`  ${event.createdAt}  ${event.type}${event.stage ? ` (${event.stage})` : ''}`);
            }
        }
        return 0;
    }),
};

export default command;
