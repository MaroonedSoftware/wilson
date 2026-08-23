import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardRepository, nextCard } from '@wilson/api/cli-bootstrap';

const command: CommandModule = {
    description: 'Pick the next card to work on',
    run: requireContainer(async (_opts, ctx) => {
        const cards = await ctx.container.get(BoardRepository).list();
        const { next, blocked } = nextCard(cards);

        if (next) {
            ctx.logger.info(`${next.frontmatter.id}  ${next.frontmatter.stage}  ${next.frontmatter.title}`);
        } else if (blocked.length === 0) {
            ctx.logger.info('nothing to do — the board has no workable cards');
        } else {
            ctx.logger.info('nothing to do — every remaining card is waiting on a dependency');
        }

        if (blocked.length > 0) {
            ctx.logger.info('\nblocked:');
            for (const { card, blockedBy } of blocked) {
                ctx.logger.info(`  ${card.frontmatter.id}  ${card.frontmatter.title}  (waiting on ${blockedBy.join(', ')})`);
            }
        }

        return 0;
    }),
};

export default command;
