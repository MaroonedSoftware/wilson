import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { StageDispatcher } from '@kanban/api/cli-bootstrap';

interface RunOpts {
    stage?: string;
}

/**
 * Run one stage for one card.
 *
 * The whole of step 0's operator surface. The queue lands at step 3 and calls the same dispatcher;
 * this command stays working permanently, because it is the recovery tool when a card breaks the
 * dispatcher (PROJECT.md, "do not saw off the branch you are sitting on").
 */
const command: CommandModule<RunOpts> = {
    description: 'Run a stage for a card in an isolated worktree, then verify its exit condition',
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    options: [{ flags: '--stage <stage>', description: 'Stage to run (default: implementing)', type: 'string' }],
    run: requireContainer<RunOpts>(async (opts, ctx, args) => {
        const cardId = String(args[0]);
        const stage = opts.stage ?? 'implementing';

        const outcome = await ctx.container.get(StageDispatcher).run(cardId, stage);

        ctx.logger.info(`\n${outcome.passed ? 'PASS' : 'FAIL'}  ${cardId} · ${stage}`);

        // The stage's own account of what it did. Printed on failure as much as success: when the
        // exit condition fails, what the agent believed it was doing is the first thing you need.
        const result = outcome.result as { summary?: string; caveats?: string[] } | undefined;
        if (result?.summary) ctx.logger.info(`\n${result.summary}`);
        if (result?.caveats?.length) {
            ctx.logger.warn('\ncaveats the stage reported:');
            for (const caveat of result.caveats) ctx.logger.warn(`  - ${caveat}`);
        }

        if (outcome.changedPaths.length > 0) {
            ctx.logger.info(`\nchanged (${outcome.changedPaths.length}):`);
            for (const path of outcome.changedPaths) ctx.logger.info(`  ${path}`);
        }

        if (outcome.scopeGrants.length > 0) {
            // Surfaced rather than buried: a widening is a fact about the run the reviewer should see.
            ctx.logger.warn(`\nscope widened for ${outcome.scopeGrants.length} path(s):`);
            for (const path of outcome.scopeGrants) ctx.logger.warn(`  ${path}`);
        }

        const usage = outcome.usage;
        if (usage) ctx.logger.info(`\ntokens: ${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out`);

        if (!outcome.passed) {
            ctx.logger.error('\nexit condition not met:');
            for (const failure of outcome.failures) ctx.logger.error(`  - ${failure}`);
            ctx.logger.info('\nThe branch is preserved for inspection.');
            return 1;
        }
        ctx.logger.info('\nReview the branch, then move the card yourself — the runner does not transition in step 0.');
        return 0;
    }),
};

export default command;
