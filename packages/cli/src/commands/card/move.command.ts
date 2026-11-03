import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { isDeadTarget } from '../../board-view.js';

/**
 * Move a card to another stage.
 *
 * The write — validating the target against the board's stage graph, recording the transition, and
 * reclaiming a terminal card's worktree — now happens behind `POST /api/cards/:id/move`
 * (`BoardWriteService.move`, card 0080), which ports this command's own rules unchanged. This
 * command reads the card first only to phrase the operator-facing message (already-there vs moved
 * vs flag-cleared); the API is what actually decides and writes.
 *
 * It also warns — but never refuses — when the target is a dead stage (`dropped`, `poisoned`):
 * anything depending on this card would otherwise be silently blocked forever (card 0090). The
 * dependent search is a plain client-side filter over `listCards()`, not a new index — nothing on
 * the server is indexed the other way round.
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

        const already = before.stage === target || before.doneReason === target;
        if (already && !clearsFlag) {
            ctx.logger.info(`${cardId} is already in ${target}`);
            return 0;
        }

        if (isDeadTarget(target)) {
            const cards = await api.board.listCards();
            const dependents = cards.filter(c => c.dependsOn.includes(cardId));
            if (dependents.length > 0) {
                ctx.logger.info(
                    `warning: ${cardId} will never reach merged from ${target} — this permanently blocks ` +
                        `${dependents.map(c => c.id).join(', ')}, which depend on it. Clear each link, or ` +
                        `leave it blocked on purpose:`,
                );
                for (const dependent of dependents) {
                    ctx.logger.info(`  wilson card depend ${dependent.id} ${cardId} --remove`);
                }
            }
        }

        await api.board.moveCard(cardId, { stage: target });

        if (already) {
            ctx.logger.info(`${cardId}: cleared flag, stays in ${target}`);
        } else {
            ctx.logger.info(`${cardId}: ${before.stage} → ${target}`);
        }
        return 0;
    }),
};

export default command;
