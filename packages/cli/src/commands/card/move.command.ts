import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Move a card to another stage.
 *
 * The write — validating the target against the board's stage graph, recording the transition, and
 * reclaiming a terminal card's worktree — now happens behind `POST /api/cards/:id/move`
 * (`BoardWriteService.move`, card 0080), which ports this command's own rules unchanged. This
 * command reads the card first only to phrase the operator-facing message (already-there vs moved
 * vs flag-cleared); the API is what actually decides and writes.
 */
const command: CommandModule = {
    description: 'Move a card to another stage, recording the transition',
    args: [
        { name: 'cardId', description: 'The card id, e.g. 0001', required: true },
        { name: 'stage', description: 'The stage to move it to', required: true },
    ],
    run: withApi(async (_opts, ctx, args, api) => {
        const [cardId, target] = [String(args[0]), String(args[1])];

        const before = await api.board.getCard(cardId);
        const clearsFlag = Boolean(before.needsHuman);

        if (before.stage === target && !clearsFlag) {
            ctx.logger.info(`${cardId} is already in ${target}`);
            return 0;
        }

        await api.board.moveCard(cardId, { stage: target });

        if (before.stage === target) {
            ctx.logger.info(`${cardId}: cleared flag, stays in ${target}`);
        } else {
            ctx.logger.info(`${cardId}: ${before.stage} → ${target}`);
        }
        return 0;
    }),
};

export default command;
