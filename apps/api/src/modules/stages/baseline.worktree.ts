import type { Logger } from '@maroonedsoftware/logger';
import { worktreeHost, type Worktree, type WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { pnpmStoreLock, runConfiguredCommand } from './run.command.js';

export interface BaselineWorktreeInput {
    /** Names the tree and its `card/<id>` branch. Two callers that could overlap on one card need different ids. */
    id: string;
    /** The card's own tree: the baseline is cut from its `baseSha`, on its host. */
    source: Worktree;
    setupCommand?: string;
    /** How this install is named while it queues for the store lock. */
    setupLabel: string;
    /**
     * Asked once the store lock is held, so time spent queueing counts against a caller with a
     * deadline. Not above zero: setup is refused rather than started. Left out: the command's default.
     */
    setupTimeoutMs?: () => number;
}

/**
 * Cut a tree at the card's base, prepare it, hand it to `use`, and reclaim it however that ends.
 *
 * `onSetupFailure` supplies the result when the tree could not be prepared, and `use` never runs.
 *
 * On the card's own host when it has one, so a caller can copy files across from the card's tree.
 *
 * Setup takes the store lock because this is another `pnpm install` into the shared store, running
 * while another card's setup may be installing too (card 0081).
 */
export const withBaselineWorktree = async <T>(
    worktrees: Pick<WorktreeManager, 'create' | 'reclaim'>,
    logger: Pick<Logger, 'info'>,
    input: BaselineWorktreeInput,
    onSetupFailure: (reason: string) => T,
    use: (baseline: Worktree) => Promise<T>,
): Promise<T> => {
    const { id, source, setupCommand, setupLabel, setupTimeoutMs } = input;
    const baseline = await worktrees.create(id, `card/${id}`, source.baseSha, source.placement);

    try {
        if (setupCommand) {
            const setup = await pnpmStoreLock.run(
                setupLabel,
                message => logger.info(message),
                async () => {
                    const timeoutMs = setupTimeoutMs?.();
                    if (timeoutMs !== undefined && timeoutMs <= 0) return { reason: 'no time was left once the install lock was free' };
                    return runConfiguredCommand(baseline.path, setupCommand, timeoutMs, undefined, worktreeHost(baseline));
                },
            );
            if (setup) return onSetupFailure(setup.reason);
        }
        return await use(baseline);
    } finally {
        await worktrees.reclaim(id, source.placement);
    }
};
