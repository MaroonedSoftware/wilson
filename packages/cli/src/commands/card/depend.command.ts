import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardRepository } from '@wilson/api/cli-bootstrap';

interface DependOpts {
    remove?: boolean;
}

/**
 * Record or drop a dependency between two cards.
 *
 * `card create` takes `dependsOn` and `syncDeps` reconciles `runner.card_deps` on every write, but
 * nothing reached that for a card that already exists — so a dependency discovered after a card was
 * written could not be recorded at all. `depends_on` is a hard block on dispatch, which makes this
 * the difference between a card waiting for the interface it needs and one racing it.
 *
 * The write goes through `BoardRepository.write` rather than an INSERT, so the change lands as a
 * card version like every other edit.
 *
 * Cycle rejection at load time (PROJECT.md, Runner requirements) is still unbuilt; this refuses the
 * self-dependency and nothing more.
 */
const command: CommandModule<DependOpts> = {
    description: 'Record that one card depends on another',
    args: [
        { name: 'cardId', description: 'The card that waits, e.g. 0035', required: true },
        { name: 'dependsOnId', description: 'The card it waits for, e.g. 0034', required: true },
    ],
    options: [{ flags: '--remove', description: 'Drop the dependency instead of adding it', type: 'boolean' }],
    run: requireContainer<DependOpts>(async (opts, ctx, args) => {
        const [cardId, dependsOnId] = [String(args[0]), String(args[1])];
        const board = ctx.container.get(BoardRepository);

        if (cardId === dependsOnId) {
            ctx.logger.error('a card cannot depend on itself');
            return 1;
        }

        // Read it before writing so a typo is a clear message rather than a foreign key violation.
        await board.read(dependsOnId);

        const before = await board.read(cardId);
        const has = before.frontmatter.dependsOn.includes(dependsOnId);
        if (opts.remove && !has) {
            ctx.logger.info(`${cardId} does not depend on ${dependsOnId}`);
            return 0;
        }
        if (!opts.remove && has) {
            ctx.logger.info(`${cardId} already depends on ${dependsOnId}`);
            return 0;
        }

        const dependsOn = opts.remove
            ? before.frontmatter.dependsOn.filter(id => id !== dependsOnId)
            : [...before.frontmatter.dependsOn, dependsOnId].sort();

        await board.write(cardId, `${opts.remove ? 'Drop' : 'Add'} ${cardId} dependency on ${dependsOnId}`, card => ({
            ...card,
            frontmatter: { ...card.frontmatter, dependsOn },
        }));

        ctx.logger.info(opts.remove ? `${cardId} no longer depends on ${dependsOnId}` : `${cardId} depends on ${dependsOnId}`);
        return 0;
    }),
};

export default command;
