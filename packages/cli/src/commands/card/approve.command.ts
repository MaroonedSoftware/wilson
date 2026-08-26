import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Approve a card's plan: pin its current version and move it from `planning` into `backlog`.
 *
 * Card 0127 reconciled this. It used to pin on the way *out* of `backlog`; now entering `backlog`
 * is the approval — the pin, and the same empty-scope refusal this command has always carried, both
 * happen behind `POST /api/cards/:id/approve` (`BoardWriteService.approve`, which is now a thin
 * `planning`-only front door onto `BoardWriteService.move`). This command just calls it and reports
 * where the card landed. Once a card reaches `backlog` this way, the poller carries it the rest of
 * the way on its own — there is no second, separate approval to leave `backlog` any more.
 */
const command: CommandModule = {
    description: "Approve a card's plan: pin its current version and move it from planning into backlog",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);

        const card = await api.board.approveCardPlan(cardId);

        ctx.logger.info(`${cardId}: planning → ${card.stage} (plan pinned)`);
        return 0;
    }),
};

export default command;
