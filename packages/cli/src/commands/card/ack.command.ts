import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardConfig, BoardRepository } from '@wilson/api/cli-bootstrap';

/**
 * Clear a card's `needsHuman` flag and give its current stage its retry budget back.
 *
 * `ack` is the other half of the flag: "I have looked at this, I fixed the plan, try again." It
 * does not move the card — the card was flagged in the stage it failed in, and that is where it
 * should try again — and it only touches the counter for that stage, so a `review` counter from an
 * earlier cycle survives a flag raised in `implementing`.
 */
const command: CommandModule = {
    description: 'Acknowledge a flagged card, clearing the flag and its current stage retry counter',
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: requireContainer(async (_opts, ctx, args) => {
        const cardId = String(args[0]);
        const config = ctx.container.get(BoardConfig);
        const board = ctx.container.get(BoardRepository);

        const before = await board.read(cardId);
        if (!before.frontmatter.needsHuman) {
            ctx.logger.error(`${cardId} is not flagged for a human — nothing to acknowledge`);
            return 1;
        }

        const stage = before.frontmatter.stage;
        const reason = before.frontmatter.needsHumanReason;
        const droppedRetries = before.frontmatter.retries[stage];

        await board.writeWithEvent(
            cardId,
            `Ack ${cardId}`,
            current => {
                // Drop `needsHuman`/`needsHumanReason` entirely rather than setting them false/undefined,
                // and drop the current stage's retry key entirely rather than zeroing it — an absent key
                // is what "never failed" looks like, and a key present with a falsy value is a second
                // shape for the same state.
                const { needsHuman: _needsHuman, needsHumanReason: _needsHumanReason, ...rest } = current.frontmatter;
                const { [current.frontmatter.stage]: _dropped, ...retries } = current.frontmatter.retries;
                return {
                    ...current,
                    frontmatter: { ...rest, retries },
                };
            },
            {
                project: config.project,
                cardId,
                stage,
                type: 'card.acked',
                payload: { stage, reason, retries: droppedRetries, by: 'human' },
            },
        );

        ctx.logger.info(`${cardId}: cleared flag (${reason ?? 'no reason recorded'}), dropped ${stage} retry counter (was ${droppedRetries ?? 0})`);
        return 0;
    }),
};

export default command;
