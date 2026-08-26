import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { deadDependencies, describeDependency, nextCard, staleDaemonCards } from '../../board-view.js';

const command: CommandModule = {
    description: 'Pick the next card to work on',
    run: withApi(async (_opts, ctx, _args, api) => {
        const [cards, columns] = await Promise.all([api.board.listCards(), api.board.listBoardColumns()]);
        const { next, blocked, flagged } = nextCard(cards, columns.nonStages);

        // Card 0100: a daemon.stale event only ever gets recorded against a card this command was
        // about to name anyway — the next candidate, a blocked one, or a flagged one — so checking
        // just those keeps this to a handful of extra requests instead of one per card on the board.
        const candidates = [...flagged, ...blocked.map(b => b.card), ...(next ? [next] : [])];
        const eventsByCard = new Map(
            await Promise.all(candidates.map(async card => [card.id, await api.board.listCardEvents(card.id, { limit: 20 })] as const)),
        );
        const stale = staleDaemonCards(candidates, eventsByCard);

        // Flagged cards print first and above everything else: a card waiting on a person is the
        // most important thing on the board, and this command is the human-facing answer to "what
        // should I do".
        if (flagged.length > 0) {
            ctx.logger.info('flagged:');
            for (const card of flagged) {
                const reason = card.needsHumanReason ?? 'needsHuman is set';
                ctx.logger.info(`  ${card.id}  ${card.title}  (${reason})`);
            }
            ctx.logger.info('');
        }

        // Alongside the flagged block, not folded into it: a card can be here without being
        // needsHuman at all — dispatch never blocks on a stale daemon (card 0100), so this is a
        // "the runner was behind when it dispatched this" note, not another reason to stop.
        if (stale.length > 0) {
            ctx.logger.info('daemon was behind at a recent dispatch:');
            for (const card of stale) {
                ctx.logger.info(`  ${card.id}  ${card.title}`);
            }
            ctx.logger.info('');
        }

        if (next) {
            ctx.logger.info(`${next.id}  ${next.stage}  ${next.title}`);
        } else if (blocked.length === 0) {
            ctx.logger.info('nothing to do — the board has no workable cards');
        } else {
            ctx.logger.info('nothing to do — every remaining card is waiting on a dependency');
        }

        if (blocked.length > 0) {
            ctx.logger.info('\nblocked:');
            for (const { card, blockedBy } of blocked) {
                const dead = deadDependencies(card, cards, columns.nonStages);
                const waitingOn = blockedBy.map(id => describeDependency(id, cards, dead)).join(', ');
                ctx.logger.info(`  ${card.id}  ${card.title}  (waiting on ${waitingOn})`);
            }
        }

        return 0;
    }),
};

export default command;
