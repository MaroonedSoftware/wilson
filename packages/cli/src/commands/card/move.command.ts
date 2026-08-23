import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardConfig, BoardRepository, EventLog, loadStages, validTargets } from '@wilson/api/cli-bootstrap';

/**
 * Move a card to another stage.
 *
 * In step 0 the human decides every transition, but the write still goes through the board library
 * rather than an editor (PROJECT.md decision 3). Hand-editing frontmatter is what the typed layer
 * exists to prevent, and a transition nobody recorded is a gap in the card's history.
 *
 * When the queue lands at step 3 the runner writes transitions itself, on the same path.
 */
const command: CommandModule = {
    description: 'Move a card to another stage, recording the transition',
    args: [
        { name: 'cardId', description: 'The card id, e.g. 0001', required: true },
        { name: 'stage', description: 'The stage to move it to', required: true },
    ],
    run: requireContainer(async (_opts, ctx, args) => {
        const [cardId, target] = [String(args[0]), String(args[1])];
        const config = ctx.container.get(BoardConfig);
        const board = ctx.container.get(BoardRepository);

        // Refuse a state the stage graph does not name. A typo would otherwise park the card
        // somewhere nothing will ever pick it up. A declared on-pass target counts even before
        // anything implements it — that is just a half-built pipeline.
        const targets = validTargets(await loadStages(config.boardRoot));
        if (!targets.includes(target)) {
            ctx.logger.error(`"${target}" is not a state this board defines. Valid: ${targets.join(', ')}`);
            return 1;
        }

        const before = await board.read(cardId);
        if (before.frontmatter.stage === target) {
            ctx.logger.info(`${cardId} is already in ${target}`);
            return 0;
        }

        const sha = await board.write(cardId, `Move ${cardId} to ${target}`, card => ({
            ...card,
            frontmatter: { ...card.frontmatter, stage: target },
        }));

        await ctx.container.get(EventLog).append({
            project: config.project,
            cardId,
            stage: target,
            type: 'transition.written',
            payload: { from: before.frontmatter.stage, to: target, by: 'human', sha },
        });

        ctx.logger.info(`${cardId}: ${before.frontmatter.stage} → ${target}`);
        return 0;
    }),
};

export default command;
