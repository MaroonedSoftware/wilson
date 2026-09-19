import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Card 0238. `wilson card merge <id>` — the operator's way to run `BoardWriteService.merge`
 * without writing a request by hand, mirroring `card lint` (`lint.command.ts`): every judgement
 * lives in that service, reached here through the generated SDK's `mergeCard`, so this command can
 * never drift from what the runner itself will enforce.
 *
 * `merged: false` is not this command failing to talk to the API — it is one of `merge`'s own
 * honest outcomes (a conflict, a failed suite, or, as of this card, a re-review send-back), always
 * carrying a `reason` (`MergeResult`'s own doc comment, `packages/sdk/src/types/board.ts`). Exit
 * code follows `card lint`'s precedent: 1 when the attempt did not land, 0 when it did, so this can
 * sit in a script without parsing text.
 */
const command: CommandModule = {
    description: "Merge a card's branch, or report why the attempt did not land",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);
        const result = await api.board.mergeCard(cardId);

        if (!result.merged) {
            ctx.logger.info(`${cardId}: not merged — ${result.reason ?? 'no reason recorded'}`);
            return 1;
        }

        ctx.logger.info(`${cardId}: merged${result.commit ? ` as ${result.commit}` : ''}${result.reason ? ` (${result.reason})` : ''}`);
        return 0;
    }),
};

export default command;
