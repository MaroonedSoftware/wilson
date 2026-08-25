import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardConfig, BoardRepository, EventLog, WorktreeManager, loadStages, validTargets } from '@wilson/api/cli-bootstrap';

/**
 * Move a card to another stage.
 *
 * In step 0 the human decides every transition, but the write still goes through the board library
 * rather than an editor (PROJECT.md decision 3). There is no longer a file to hand-edit, and a
 * transition nobody recorded is a gap in the card's history.
 *
 * When the queue lands at step 3 the runner writes transitions itself, on the same path.
 */
const command: CommandModule = {
    description: 'Move a card to another stage, recording the transition',
    args: [
        { name: 'cardId', description: 'The card id, e.g. 0001', required: true },
        { name: 'stage', description: 'The stage to move it to', required: true },
    ],
    run: requireContainer(async (_opts, ctx, args) => {
        const [cardId, target] = [String(args[0]), String(args[1])];
        const config = ctx.container.get(BoardConfig);
        const board = ctx.container.get(BoardRepository);
        const worktrees = ctx.container.get(WorktreeManager);
        const events = ctx.container.get(EventLog);

        // Refuse a state the stage graph does not name. A typo would otherwise park the card
        // somewhere nothing will ever pick it up. A declared on-pass target counts even before
        // anything implements it — that is just a half-built pipeline.
        const targets = validTargets(await loadStages(config.boardRoot));
        if (!targets.includes(target)) {
            ctx.logger.error(`"${target}" is not a state this board defines. Valid: ${targets.join(', ')}`);
            return 1;
        }

        const before = await board.read(cardId);

        // Moving a card by hand is already an operator saying they have looked, so a flag comes off
        // on any move — including the no-op case below, where the card is already in the target
        // stage. That path used to be a bare no-op; a flagged card sitting in its target stage still
        // needs the flag cleared, so it cannot stay a no-op when there is a flag to clear.
        const clearsFlag = Boolean(before.frontmatter.needsHuman);

        if (before.frontmatter.stage === target && !clearsFlag) {
            ctx.logger.info(`${cardId} is already in ${target}`);
            return 0;
        }

        // The move and the event recording it commit together. The payload no longer carries the
        // version id: it cannot, because the event is written inside the same transaction that
        // mints it — and it no longer needs to, because a version row for this move is in that
        // transaction too.
        await board.writeWithEvent(
            cardId,
            `Move ${cardId} to ${target}`,
            card => {
                const { needsHuman: _needsHuman, needsHumanReason: _needsHumanReason, ...rest } = card.frontmatter;
                return {
                    ...card,
                    frontmatter: { ...rest, stage: target },
                };
            },
            {
                project: config.project,
                cardId,
                stage: target,
                type: 'transition.written',
                payload: { from: before.frontmatter.stage, to: target, by: 'human' },
            },
        );

        // `wilson card move` is the operator's override, and it writes a real transition — so it
        // reclaims on the same rule the runner uses, `reclaimIfTerminal` (isTerminal(target)), rather
        // than growing its own idea of when a card is done. `clearsFlag` is exactly "was this card
        // flagged before this move", which is what must gate reclaiming even though this same move is
        // what clears the flag (card 0055 keeps a flagged card's tree on purpose). Best-effort: the
        // transition above already stands, so a failure here is logged, not thrown.
        const reclaimed = await board.reclaimIfTerminal(worktrees, events, {
            project: config.project,
            cardId,
            stage: target,
            target,
            flagged: clearsFlag,
        });
        if (reclaimed.error) {
            ctx.logger.warn(`could not reclaim worktree for ${cardId} after moving to "${target}": ${reclaimed.error}`);
        }

        if (before.frontmatter.stage === target) {
            ctx.logger.info(`${cardId}: cleared flag, stays in ${target}`);
        } else {
            ctx.logger.info(`${cardId}: ${before.frontmatter.stage} → ${target}`);
        }
        return 0;
    }),
};

export default command;
