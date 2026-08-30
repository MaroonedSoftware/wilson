import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { runInteractive } from './editor.js';

const exec = promisify(execFile);

interface DiffOpts {
    tool?: boolean;
}

/**
 * Show a card's code diff.
 *
 * Delegates to git rather than building a viewer: `git difftool` already knows Beyond Compare,
 * Araxis, DeltaWalker, VS Code, vimdiff and more, configured the way every operator already
 * configures it (`git config diff.tool`) — this command's only job is deciding *which commits*.
 *
 * The range is `merge-base(main, branch)..branch`, never `main..branch`. A card's branch usually
 * forks from an older `main`, so `main..branch` reports every file `main` has gained since as a
 * deletion this card never touched — a misreading that nearly got acted on twice on this board in
 * one day (cards 0120 and 0143).
 *
 * `branch` comes from the API's `resolvedBranch` (`CardSummary`, card 0160), not `CardSummary.branch`
 * — most cards never record one, and `WorktreeManager.resolveBranch` is the one place that derives
 * the fallback, so this reads its answer rather than re-deriving it. `codeRoot` likewise comes from
 * `GET /api/health`, the same source `wilson doctor` trusts, rather than assuming the current
 * directory is the code repo — this command works from anywhere the API is reachable.
 *
 * A branch that has never been cut (the card has never reached `implementing`) is refused by name,
 * not shown as an empty diff — an empty diff reads as "no changes", which is a different, false
 * claim.
 */
const command: CommandModule<DiffOpts> = {
    description: "Show a card's code diff: merge-base(main, branch)..branch, paged in the terminal or opened in a configured difftool",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    options: [
        {
            flags: '--tool',
            description: "Run the same range through `git difftool` instead of paging it here, so a configured tool (e.g. Beyond Compare) opens it",
            type: 'boolean',
        },
    ],
    run: withApi<DiffOpts>(async (opts, ctx, args, api) => {
        const cardId = String(args[0]);

        const [card, health] = await Promise.all([api.board.getCard(cardId), api.health.getHealth()]);
        const branch = card.resolvedBranch;
        const codeRoot = health.codeRoot;

        if (!branch) {
            ctx.logger.error(`${cardId} has no resolved branch to diff.`);
            return 1;
        }

        const branchExists = await exec('git', ['rev-parse', '--verify', '--quiet', branch], { cwd: codeRoot }).then(
            () => true,
            () => false,
        );
        if (!branchExists) {
            ctx.logger.error(`${cardId} has no branch yet — it has never reached implementing, so there is nothing to diff.`);
            return 1;
        }

        const { stdout: forkPoint } = await exec('git', ['merge-base', 'main', branch], { cwd: codeRoot });
        const range = `${forkPoint.trim()}..${branch}`;

        await runInteractive('git', [opts.tool ? 'difftool' : 'diff', range], { cwd: codeRoot });
        return 0;
    }),
};

export default command;
