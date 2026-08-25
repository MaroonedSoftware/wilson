import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Release a card whose job is stuck: cancel the job through the broker and clear the claim.
 *
 * The in-flight check, the running-daemon disambiguation (refusing when a `wilson run` daemon is up
 * and the claim might genuinely be live), and the cancel-and-clear itself all happen behind
 * `POST /api/cards/:id/release` now (`BoardWriteService.release`, card 0080) — ported from this
 * command unchanged, `pgrep -f 'index.ts run'` included. This command just calls it.
 */
const command: CommandModule = {
    description: "Release a card's stuck job: cancel it through the broker and clear the claim",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);

        await api.board.releaseCard(cardId);

        ctx.logger.info(`${cardId}: released — job cancelled, claim cleared`);
        ctx.logger.info('the card itself has not moved; decide where it goes next with `wilson card move`.');
        return 0;
    }),
};

export default command;
