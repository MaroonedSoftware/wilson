import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Approve a card's plan, pinning it and moving the card out of `backlog`.
 *
 * The stage guard, the empty-scope refusal, and pinning the version behind the move all happen
 * behind `POST /api/cards/:id/approve` now (`BoardWriteService.approve`, card 0080), which ports
 * this command's own rules — including the version it pins — unchanged. This command just calls it
 * and reports where the card landed.
 */
const command: CommandModule = {
    description: "Approve a card's plan: pin its current version and move it out of backlog",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);

        const card = await api.board.approveCardPlan(cardId);

        ctx.logger.info(`${cardId}: backlog → ${card.stage} (plan pinned)`);
        return 0;
    }),
};

export default command;
