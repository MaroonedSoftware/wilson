import type { ScopeGuard } from '#modules/agent/scope.guard.js';
import type { Card } from '#modules/board/card.js';
import type { Worktree } from '#modules/worktree/worktree.manager.js';
import { runConfiguredCommand } from './run.command.js';
import type { StageConfig } from './stage.config.js';

export interface VerificationInput {
    worktree: Worktree;
    scope: ScopeGuard;
    stage: StageConfig;
    /** The card being verified. Only the testing verifier's baseline check uses it. */
    cardId: string;
    /**
     * The pinned card whose plan this stage ran against — `run`'s own `card`, at `planVersionId`,
     * not the live board row. `ReviewVerifier` reads it to reconcile a review's `criteria` against
     * `acceptanceCriteria(card)`, and `TestingVerifier` reads it to honor a declared
     * `expectedSkippedTests(card)` ceiling; every other verifier ignores it.
     */
    card: Card;
    /** The stage's reported result, exactly as read off the report tool call. Unparsed until a verifier validates it against its own schema. */
    result: unknown;
}

export interface VerificationOutcome {
    passed: boolean;
    failures: string[];
    changedPaths: string[];
}

export interface StageVerifier {
    verify(input: VerificationInput): Promise<VerificationOutcome>;
}

/**
 * Run the stage's format check, if configured, and report the tool's own failure as an exit
 * condition — the same shape `buildCommand` already runs inline in `ImplementingVerifier`, pulled
 * out here so every verifier whose stage may write code shares one check instead of each growing
 * its own copy that can drift out of sync.
 *
 * An unset `formatCommand` is not a failure: a stage that never configures one runs no check at
 * all, exactly like an unset `buildCommand` today.
 */
export const checkFormat = async (worktree: Worktree, stage: StageConfig): Promise<string[]> => {
    if (!stage.formatCommand) return [];
    const failure = await runConfiguredCommand(worktree.path, stage.formatCommand);
    return failure ? [failure.reason] : [];
};

/**
 * The DI token for the stage-name -> verifier map. A class extending Map is registered by
 * identity, the same way this repo's other registry maps are:
 * `registry.register(StageVerifierMap).useInstance(map)`.
 */
export class StageVerifierMap extends Map<string, StageVerifier> {}
