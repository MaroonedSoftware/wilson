import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Rename a card's title.
 *
 * The refusal rules — a no-op for an unchanged title, an empty or whitespace-only title, and a
 * title whose current-title branch already carries commits — all happen behind
 * `POST /api/cards/:id/rename` (`BoardWriteService.rename`, card 0094); this command reads the card
 * first only to phrase the old-title/new-title message and to skip the round trip for the common
 * no-op of re-running with the same title unchanged.
 */
const command: CommandModule = {
    description: "Rename a card's title",
    args: [
        { name: 'cardId', description: 'The card id, e.g. 0001', required: true },
        { name: 'title', description: 'The new title', required: true },
    ],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);
        const title = String(args[1]);

        const before = await api.board.getCard(cardId);
        if (title === before.title) {
            ctx.logger.info(`${cardId}: title unchanged`);
            return 0;
        }

        const after = await api.board.renameCard(cardId, { title });
        ctx.logger.info(`${cardId}: "${before.title}" → "${after.title}"`);
        return 0;
    }),
};

export default command;
