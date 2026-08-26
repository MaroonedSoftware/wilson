import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { deadDependencies, describeDependency, unsatisfiedDependencies } from '../../board-view.js';

const command: CommandModule = {
    description: 'List every card on the board with its stage',
    run: withApi(async (_opts, ctx, _args, api) => {
        const [cards, columns] = await Promise.all([api.board.listCards(), api.board.listBoardColumns()]);
        if (cards.length === 0) {
            ctx.logger.info('no cards yet — `wilson board init` scaffolds the board, then write one by hand');
            return 0;
        }

        const width = Math.max(...cards.map(c => c.stage.length));
        for (const card of cards) {
            const outstanding = unsatisfiedDependencies(card, cards);
            const dead = deadDependencies(card, cards, columns.nonStages);
            const blocked =
                outstanding.length > 0
                    ? ` (blocked on ${outstanding.map(id => describeDependency(id, cards, dead)).join(', ')})`
                    : '';
            const flag = card.needsHuman ? ' [needs human]' : '';
            ctx.logger.info(`${card.id}  ${card.stage.padEnd(width)}  ${card.title}${blocked}${flag}`);
        }
        return 0;
    }),
};

export default command;
