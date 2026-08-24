import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardRepository, unsatisfiedDependencies } from '@wilson/api/cli-bootstrap';

const command: CommandModule = {
    description: 'List every card on the board with its stage',
    run: requireContainer(async (_opts, ctx) => {
        const cards = await ctx.container.get(BoardRepository).list();
        if (cards.length === 0) {
            ctx.logger.info('no cards yet — `wilson board init` scaffolds the board, then write one by hand');
            return 0;
        }

        const width = Math.max(...cards.map(c => c.frontmatter.stage.length));
        for (const card of cards) {
            const outstanding = unsatisfiedDependencies(card, cards);
            const blocked = outstanding.length > 0 ? ` (blocked on ${outstanding.join(', ')})` : '';
            ctx.logger.info(`${card.frontmatter.id}  ${card.frontmatter.stage.padEnd(width)}  ${card.frontmatter.title}${blocked}`);
        }
        return 0;
    }),
};

export default command;
