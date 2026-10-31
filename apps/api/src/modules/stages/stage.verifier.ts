import type { ScopeGuard } from '#modules/agent/scope.guard.js';
import type { Card } from '#modules/board/card.js';
import { worktreeHost, type Worktree } from '#modules/worktree/worktree.manager.js';
import { runConfiguredCommand } from './run.command.js';
import type { StageConfig } from './stage.config.js';
import type { SupportedRefusal } from './stage.result.js';

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
    /**
     * Set when every failure above is a fault in the stage's own report — a hallucinated citation, an
     * inconsistent verdict, a reviewer that wrote files — rather than a statement about the card's
     * code. Card 0249: `ReviewVerifier` rejected a passing review over AC7's citation of
     * `cli.tool.guard.test.ts`, a file correctly outside the diff, and the rejection then routed
     * through `review.onFail` to `challenge` and on to `implementing` — stages with nothing to fix,
     * since the code was never at fault. `StageDispatcher.runAgent` folds this into `unjudged` so
     * `kickback` retries the same stage instead, the same way a truncated run or a dropped result do;
     * it still charges `retries[stage.name]`, so a stage that keeps producing a bad report still
     * reaches `needsHuman` at `maxKickbacks`. Optional because most verifiers never draw this
     * distinction and so never set it at all; `ReviewVerifier` and `ChallengeVerifier`, which do,
     * always compute it as an explicit `true` or `false` once they reach a `return` — unlike
     * `resultDropped`/`engineStopReason` elsewhere in this module, there is no "does not apply" case
     * partway through their own checks, only "review found a code fact" (`false`) versus "every
     * failure was about the report" (`true`). Every read site uses `Boolean(...)`, so an unset field
     * and an explicit `false` are indistinguishable to a consumer either way.
     */
    reportRejected?: boolean;
    /**
     * Set by `ScopeCheckVerifier` alone, and only when the refusal is the one and only failure: the
     * evidence backed it and nothing else in the report was wrong. A `refusing:` failure alongside
     * any other is a report this stage does not fully believe, so it carries no division to act on.
     */
    supportedRefusal?: SupportedRefusal;
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
    const failure = await runConfiguredCommand(worktree.path, stage.formatCommand, undefined, undefined, worktreeHost(worktree));
    return failure ? [failure.reason] : [];
};

/**
 * The DI token for the stage-name -> verifier map. A class extending Map is registered by
 * identity, the same way this repo's other registry maps are:
 * `registry.register(StageVerifierMap).useInstance(map)`.
 */
export class StageVerifierMap extends Map<string, StageVerifier> {}
