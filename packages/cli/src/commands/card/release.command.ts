import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Release a card whose job is stuck: cancel the job through the broker and clear the claim.
 *
 * The in-flight check, the running-daemon disambiguation, and the cancel-and-clear itself all
 * happen behind `POST /api/cards/:id/release` now (`BoardWriteService.release`, card 0080). Since
 * card 0079 the API is the only daemon, so the disambiguation isn't "is a daemon up" — it's whether
 * *this* process's own `CardStageJob` handler is mid-run on this card right now (`RunningCards`,
 * checked in `release()`), which distinguishes a genuinely live claim from one left behind by an
 * earlier process that crashed before clearing it. This command just calls the endpoint.
 *
 * Card 0087: the response's `releasedAs` names which of the two safe-to-cancel cases the service
 * took, so the two get different lines here rather than one message standing in for both.
 */
const command: CommandModule = {
    description: "Release a card's stuck job: cancel it through the broker and clear the claim",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);

        const result = await api.board.releaseCard(cardId);
        const cancelled =
            result.releasedAs === 'orphan' ? 'an orphaned job left behind by an earlier process' : 'a queued job that had not started';

        ctx.logger.info(`${cardId}: released — cancelled ${cancelled}, claim cleared`);
        ctx.logger.info('the card itself has not moved; decide where it goes next with `wilson card move`.');
        return 0;
    }),
};

export default command;
