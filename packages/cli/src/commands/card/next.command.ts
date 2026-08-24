import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardRepository, nextCard } from '@wilson/api/cli-bootstrap';

const command: CommandModule = {
    description: 'Pick the next card to work on',
    run: requireContainer(async (_opts, ctx) => {
        const cards = await ctx.container.get(BoardRepository).list();
        const { next, blocked, flagged } = nextCard(cards);

        // Flagged cards print first and above everything else: a card waiting on a person is the
        // most important thing on the board, and this command is the human-facing answer to "what
        // should I do".
        if (flagged.length > 0) {
            ctx.logger.info('flagged:');
            for (const card of flagged) {
                const reason = card.frontmatter.needsHumanReason ?? 'needsHuman is set';
                ctx.logger.info(`  ${card.frontmatter.id}  ${card.frontmatter.title}  (${reason})`);
            }
            ctx.logger.info('');
        }

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
