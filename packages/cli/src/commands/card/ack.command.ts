import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Clear a card's `needsHuman` flag and give its current stage its retry budget back.
 *
 * `ack` is the other half of the flag: "I have looked at this, I fixed the plan, try again." It
 * does not move the card — the card was flagged in the stage it failed in, and that is where it
 * should try again — and it only touches the counter for that stage, so a `review` counter from an
 * earlier cycle survives a flag raised in `implementing`. Both the flag and stage refusal and the
 * retry-counter reset happen behind `POST /api/cards/:id/ack` now (`BoardWriteService.ack`, card
 * 0080); this command reads the card first only for the reason to echo back. The dropped retry
 * count itself is no longer shown — `retries` is not part of the board API's wire contract
 * (`CardSummary`/`CardDetail`), so a client has no way to read it any more.
 */
const command: CommandModule = {
    description: 'Acknowledge a flagged card, clearing the flag and its current stage retry counter',
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);

        const before = await api.board.getCard(cardId);
        const reason = before.needsHumanReason;
        const stage = before.stage;

        await api.board.acknowledgeAFlaggedCard(cardId);

        ctx.logger.info(`${cardId}: cleared flag (${reason ?? 'no reason recorded'}), ${stage} retry counter reset`);
        return 0;
    }),
};

export default command;
