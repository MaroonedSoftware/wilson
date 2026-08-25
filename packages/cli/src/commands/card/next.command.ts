import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { nextCard } from '../../board-view.js';

const command: CommandModule = {
    description: 'Pick the next card to work on',
    run: withApi(async (_opts, ctx, _args, api) => {
        const [cards, columns] = await Promise.all([api.board.listCards(), api.board.listBoardColumns()]);
        const { next, blocked, flagged } = nextCard(cards, columns.nonStages);

        // Flagged cards print first and above everything else: a card waiting on a person is the
        // most important thing on the board, and this command is the human-facing answer to "what
        // should I do".
        if (flagged.length > 0) {
            ctx.logger.info('flagged:');
            for (const card of flagged) {
                const reason = card.needsHumanReason ?? 'needsHuman is set';
                ctx.logger.info(`  ${card.id}  ${card.title}  (${reason})`);
            }
            ctx.logger.info('');
        }

        if (next) {
            ctx.logger.info(`${next.id}  ${next.stage}  ${next.title}`);
        } else if (blocked.length === 0) {
            ctx.logger.info('nothing to do — the board has no workable cards');
        } else {
            ctx.logger.info('nothing to do — every remaining card is waiting on a dependency');
        }

        if (blocked.length > 0) {
            ctx.logger.info('\nblocked:');
            for (const { card, blockedBy } of blocked) {
                ctx.logger.info(`  ${card.id}  ${card.title}  (waiting on ${blockedBy.join(', ')})`);
            }
        }

        return 0;
    }),
};

export default command;
