import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardConfig, BoardRepository, filesInScope, findStage, loadStages } from '@wilson/api/cli-bootstrap';

/**
 * Approve a card's plan, pinning it and moving the card out of `backlog`.
 *
 * `planVersionId` has existed since the beginning and has never once been set: `StageDispatcher.run`
 * reads a card at its pinned version so an edit landing while a stage runs cannot retroactively
 * change the contract the running agent is working to, but every card ever run took the "no pinned
 * version" fallback and ran against current state instead. `backlog` is where a person reads a plan
 * before it does anything, so this is the moment that reading becomes a decision: approving pins the
 * version holding the text they just read, not whatever the card grows into later.
 *
 * A distinct command, not a side effect of `wilson card move` — moving a card out of `backlog` some
 * other way must not silently pin anything, and an operator override that records a transition stays
 * exactly that.
 */
const command: CommandModule = {
    description: "Approve a card's plan: pin its current version and move it out of backlog",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: requireContainer(async (_opts, ctx, args) => {
        const cardId = String(args[0]);
        const config = ctx.container.get(BoardConfig);
        const board = ctx.container.get(BoardRepository);

        const card = await board.read(cardId);
        if (card.frontmatter.stage !== 'backlog') {
            ctx.logger.error(`cannot approve ${cardId}: it is in "${card.frontmatter.stage}", not "backlog"`);
            return 1;
        }

        // An empty "Files in scope" would dispatch straight into `NotDispatchableError`'s
        // `empty-scope` case later, with nothing writable for the stage to act on. `backlog` is the
        // last place a person is looking at the plan before that happens.
        if (filesInScope(card).length === 0) {
            ctx.logger.error(`cannot approve ${cardId}: its plan's "Files in scope" is empty — nothing would be writable`);
            return 1;
        }

        // Where approval sends the card: `backlog`'s own `onPass` target, not a hard-coded
        // `implementing`. Stages are config, not code (PROJECT.md decision 8).
        const stages = await loadStages(config.boardRoot);
        const target = findStage(stages, 'backlog').onPass;

        // `payload` is mutated from inside `mutate`, below, before `writeWithEvent` appends this
        // event — the object literal is evaluated now, but nothing reads its `planVersionId` until
        // after the pinned version is known.
        const payload: Record<string, unknown> = { from: 'backlog', to: target, by: 'human' };

        await board.writeWithEvent(
            cardId,
            `Approve ${cardId}`,
            async current => {
                // `writeIn` snapshots the card *after* this callback returns, so `currentVersion`
                // read here still returns the version from before this move — the one holding the
                // plan text just approved, not the version this approval itself is about to create.
                const pinnedVersion = await board.currentVersion(cardId);
                payload.planVersionId = pinnedVersion;
                return {
                    ...current,
                    frontmatter: { ...current.frontmatter, stage: target, planVersionId: pinnedVersion },
                };
            },
            {
                project: config.project,
                cardId,
                stage: target,
                type: 'transition.written',
                payload,
            },
        );

        ctx.logger.info(`${cardId}: backlog → ${target} (plan pinned)`);
        return 0;
    }),
};

export default command;
