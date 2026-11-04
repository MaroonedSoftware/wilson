import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { editBody } from './editor.js';

/**
 * Answer the question a stage stopped to ask. The answer goes into the card's plan under
 * `## Operator answer`, the flag comes off, and the stage runs again in a fresh session when next
 * dispatched. Retries are kept, unlike `wilson card ack`. With no answer on the command line,
 * `$EDITOR` opens, with the conventions of `wilson card edit`: closed empty, nothing is written.
 */
const command: CommandModule = {
    description: 'Answer the question a stage stopped to ask, so it can run again',
    args: [
        { name: 'cardId', description: 'The card id, e.g. 0001', required: true },
        { name: 'answer', description: 'The answer. Left out, $EDITOR opens' },
    ],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);

        const card = await api.board.getCard(cardId);
        if (!card.blocked) {
            ctx.logger.error(`${cardId} has no question waiting for an answer`);
            return 1;
        }

        ctx.logger.info(`${card.blocked.stage} asks: ${card.blocked.question}`);
        const answer = args[1] === undefined ? await editBody('', `wilson-${cardId}-answer`) : String(args[1]);
        if (answer === undefined) {
            ctx.logger.info('empty answer — nothing written');
            return 1;
        }

        await api.board.answerABlockedCard(cardId, { answer });
        ctx.logger.info(`${cardId}: answered. ${card.blocked.stage} runs again when next dispatched (now, with \`wilson card start ${cardId}\`).`);
        return 0;
    }),
};

export default command;
