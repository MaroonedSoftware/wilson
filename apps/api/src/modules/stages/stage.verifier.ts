import type { ScopeGuard } from '#modules/agent/scope.guard.js';
import { expectedSecretPaths, type Card } from '#modules/board/card.js';
import { worktreeHost, type Worktree, type WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { runConfiguredCommand } from './run.command.js';
import { scanAddedLines, type SecretFinding } from './secret.scan.js';
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
    /**
     * Set when the failure needs a person's decision and another attempt would only hide the question.
     * The card stays where it failed, flagged with this reason, however many retries it has left.
     */
    needsHumanReason?: string;
    /**
     * Set by `TestingVerifier` alone: failing tests it did not hold against the card because they
     * fail on the baseline tree too (`failingTestKey`-formatted). Recorded, never a failure.
     */
    preExistingFailures?: string[];
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

const DECLARE_SECRET = 'A plan Constraint `Expected secret: path (reason)` allows a fixture in that file.';

const describeSecret = ({ path, line, kind }: SecretFinding): string => `${path}:${line} adds a suspected ${kind}`;

export interface SecretCheck {
    failures: string[];
    needsHumanReason?: string;
}

/**
 * Whether the card's diff adds a credential, measured from the fork point so that it also sees what
 * an earlier stage left behind. Text built here holds a location and a kind and never the value.
 *
 * A finding flags a person rather than kicking back. Nothing a retry can do settles it: if the key is
 * real it has to be rotated, and a second attempt that deleted it would pass and advance with nobody
 * told. A retry would also reward disguising the value over removing it. The formats are narrow enough
 * that a flag is rare, and a fixture has `expectedSecretPaths`.
 *
 * Failing to read the diff is a failure, since an unread diff is not a clean one, but not a flag. The
 * message leaves out the error's text, which is no use here and would be one more way out for the value.
 */
export const checkSecrets = async (worktrees: WorktreeManager, worktree: Worktree, card: Card): Promise<SecretCheck> => {
    let files: Awaited<ReturnType<WorktreeManager['addedLines']>>;
    try {
        files = await worktrees.addedLines(worktree);
    } catch {
        return { failures: ['the secret check could not read this card’s diff, so it does not know whether a credential was added'] };
    }

    const allowed = new Set(expectedSecretPaths(card));
    const findings = files.filter(file => !allowed.has(file.path)).flatMap(file => scanAddedLines(file.path, file.lines));
    const [first] = findings;
    if (!first) return { failures: [] };

    const more = findings.length > 1 ? ` (and ${findings.length - 1} more)` : '';
    return {
        failures: findings.map(finding => `${describeSecret(finding)}, value withheld. ${DECLARE_SECRET}`),
        needsHumanReason:
            `possible credential in this card's diff: ${describeSecret(first)}${more}. Rotate it if it is real. The value is still in ` +
            `the worktree, and the next run saves it to the failed-attempt patch, which that run can read. ${DECLARE_SECRET}`,
    };
};

/**
 * The DI token for the stage-name -> verifier map. A class extending Map is registered by
 * identity, the same way this repo's other registry maps are:
 * `registry.register(StageVerifierMap).useInstance(map)`.
 */
export class StageVerifierMap extends Map<string, StageVerifier> {}
