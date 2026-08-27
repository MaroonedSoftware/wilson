import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { editBody } from './editor.js';

/**
 * Edit a card's body in `$EDITOR`.
 *
 * The operator's escape hatch. With the board behind the API there is no file to open when a card is
 * wedged and the web app is not up, and a runner you cannot unstick by hand is a runner that strands
 * work. Frontmatter is deliberately not editable here: stage, branch and retries are runner state
 * (decision 5), and `wilson card move` is the recorded way to override one. A title is none of those
 * three — it is authored content, the same as the body — and has its own command, `wilson card
 * rename` (card 0094), rather than being folded into this one.
 *
 * Saving appends a version rather than overwriting, so the previous text is still there.
 */
const command: CommandModule = {
    description: "Edit a card's plan body in $EDITOR",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);

        const before = await api.board.getCard(cardId);
        const body = await editBody(before.body, `wilson-card-${cardId}`);
        if (body === undefined) {
            ctx.logger.info('empty body — nothing written');
            return 1;
        }
        if (body === before.body) {
            ctx.logger.info('unchanged');
            return 0;
        }

        await api.board.editCardBody(cardId, { body });
        ctx.logger.info(`${cardId} updated`);
        return 0;
    }),
};

export default command;
