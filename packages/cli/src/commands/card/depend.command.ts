import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

interface DependOpts {
    remove?: boolean;
}

/**
 * Record or drop a dependency between two cards.
 *
 * `wilson card create` takes `dependsOn` and `syncDeps` reconciles `wilson.card_deps` on every
 * write, but nothing reached that for a card that already exists — so a dependency discovered after
 * a card was written could not be recorded at all. `depends_on` is a hard block on dispatch, which
 * makes this the difference between a card waiting for the interface it needs and one racing it.
 *
 * The self-dependency refusal and the existing-dependency no-op both happen behind
 * `POST /api/cards/:id/depend` now (`BoardWriteService.depend`, card 0080); this command reads the
 * card first only to phrase the already-there/already-gone message.
 */
const command: CommandModule<DependOpts> = {
    description: 'Record that one card depends on another',
    args: [
        { name: 'cardId', description: 'The card that waits, e.g. 0035', required: true },
        { name: 'dependsOnId', description: 'The card it waits for, e.g. 0034', required: true },
    ],
    options: [{ flags: '--remove', description: 'Drop the dependency instead of adding it', type: 'boolean' }],
    run: withApi<DependOpts>(async (opts, ctx, args, api) => {
        const [cardId, dependsOnId] = [String(args[0]), String(args[1])];

        const before = await api.board.getCard(cardId);
        const has = before.dependsOn.includes(dependsOnId);
        if (opts.remove && !has) {
            ctx.logger.info(`${cardId} does not depend on ${dependsOnId}`);
            return 0;
        }
        if (!opts.remove && has) {
            ctx.logger.info(`${cardId} already depends on ${dependsOnId}`);
            return 0;
        }

        await api.board.setCardDependency(cardId, { dependsOnId, remove: opts.remove });

        ctx.logger.info(opts.remove ? `${cardId} no longer depends on ${dependsOnId}` : `${cardId} depends on ${dependsOnId}`);
        return 0;
    }),
};

export default command;
