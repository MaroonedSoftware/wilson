import { Injectable } from 'injectkit';
import { BoardConfig } from '#modules/board/board.config.js';
import { EventLog } from '#modules/events/event.log.js';
import { ChallengeResultSchema, ReviewResultSchema, type ReviewCriterion, type ReviewFinding } from './stage.result.js';
import { ReviewVerifier } from './review.verifier.js';
import type { StageVerifier, VerificationInput, VerificationOutcome } from './stage.verifier.js';

/** Whitespace-normalised, case-folded, so a reformatted blocker still matches its own review finding. */
const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The challenge stage's exit condition: does this run's report actually account for the blockers the
 * preceding review raised, refuting some and upholding the rest, and for the criteria review reported
 * still `unmet`, turning some into `met` with evidence and leaving the rest exactly as review found
 * them — rather than inventing or dropping any of them.
 *
 * Composes `ReviewVerifier` for everything a review-shaped result already needs checked — no writes
 * (a challenger judges, it does not edit, same as a reviewer), every finding's and every `met`
 * criterion's provenance against the diff, and `verdict`/blocker/criterion consistency — since
 * `ChallengeResultSchema` is `ReviewResultSchema` plus `refuted`, and `findings`/`criteria` here carry
 * the same kind of entries a review reports. What this class adds on top is the accounting rule that
 * makes "challenge" mean something rather than letting a run silently drop a blocker it had no answer
 * for, or silently drop an unmet criterion: every blocker the *incoming* review raised must appear
 * exactly once, either upheld in `findings` or refuted with a non-empty `reason` in `refuted`, matched
 * on `normalize(problem)` rather than `file`/`line` — the dispatcher rebases the card's branch onto
 * head before this stage runs, so a line number the review cited can have moved by the time challenge
 * reads it — and every criterion ID the incoming review reported must appear exactly once in this
 * run's own `criteria`, unchanged except that an `unmet` may become `met` (a refutation, which
 * `ReviewVerifier`'s own provenance check then holds to the same file-and-line evidence any other
 * `met` criterion needs). Criteria are matched by `id` rather than normalised text, since a plan's
 * criterion ID is already its own stable identifier — there is nothing to normalise the way a
 * blocker's free-text `problem` needs.
 *
 * The combined verdict rule, exactly: `revise` iff at least one blocker is upheld in `findings` or at
 * least one criterion in `criteria` is `unmet`. This class does not check that rule itself — it is
 * `ReviewVerifier`'s own post-0236 `hasBlocker`/`hasUnmet` consistency check, reached by composition
 * against this same `result`, since `findings` and `criteria` mean the same thing in both schemas. It
 * has to be that one rule, not a second one stated independently here: before the criteria accounting
 * above existed, a run could refute every blocker while silently dropping an `unmet` criterion from
 * `criteria`, and `ReviewVerifier`'s composed check would then see no blocker and no `unmet` criterion
 * and wave through a `pass` that review never actually cleared. Carrying every incoming criterion
 * forward is what makes the composed check mean the same thing here that it means for a review.
 *
 * The incoming blockers and criteria come from `EventLog.tail`, not the card body: `wilson card show`/
 * the body's rendered bullets print `file:undefined` for an omission finding, so parsing them back out
 * would be lossy in exactly the cases this stage most needs to get right. Specifically, the most
 * recent *stage-outcome* event on this card whose `stage` is `'review'` must be `stage.passed` and its
 * `payload.result` must parse as `ReviewResultSchema` with `verdict: 'revise'` — that is what
 * `review.onFail: challenge` routes here in the first place (a review with no blocker and no `unmet`
 * criterion never fails its own verifier's consistency check the way `shouldAdvance`, `kickback.ts`,
 * reads it). "Stage-outcome" excludes `transition.written`: `StageDispatcher.writeTransition` stamps
 * that event with `stage: stageName` too, and appends it right after `stage.passed`/`stage.failed`, so
 * on a card that just kicked back it is the most recent `'review'`-tagged row of all — `incomingReview`
 * skips past it rather than reading it as "the review event", or this scan would report "nothing to
 * challenge" on every single kickback instead of the one it actually means. Anything else — no review
 * event at all, the most recent one `stage.failed`, or a `verdict` other than `'revise'` — means there
 * is nothing for this stage to do, so `verify` fails with "nothing to challenge" rather than running
 * the accounting check against an empty or wrong blocker/criteria list. That failure routes through
 * `challenge.onFail` to `implementing`, which is today's behaviour for a `revise` review before this
 * card — this stage is a detour in front of it, not a replacement.
 *
 * An incoming review with no criteria — `ReviewResultSchema.criteria` defaults to `[]` for a plan
 * without acceptance criteria bullets — leaves the criteria accounting off entirely, the same way
 * `ReviewVerifier`'s own plan-criteria check turns itself off in that case.
 *
 * Two known limitations, left for a later card:
 *
 * - The `cli` adapter ignores `stage.model` (see that adapter's own doc comment), so a `challenge`
 *   stage configured with it runs on the engine's default model, not a cheaper one picked for this
 *   lighter-weight task. Passing `stage.model` through the `cli` adapter is out of this card's scope;
 *   a board that wants a cheaper challenge model needs `adapter: api` instead.
 * - Review's own `maxKickbacks`-th `revise` flags the card for a human before `onFail` is consulted
 *   (`kickback.ts`), so that last round never reaches `challenge` — the blockers and unmet criteria on
 *   it are never refuted or resolved, however weak they might be.
 */
@Injectable()
export class ChallengeVerifier implements StageVerifier {
    constructor(
        private readonly reviewVerifier: ReviewVerifier,
        private readonly events: EventLog,
        private readonly config: BoardConfig,
    ) {}

    async verify(input: VerificationInput): Promise<VerificationOutcome> {
        const { cardId, result } = input;
        const reviewOutcome = await this.reviewVerifier.verify(input);
        const failures = [...reviewOutcome.failures];

        // Whether every failure is a fault in this stage's own report rather than a statement about
        // the code — the same `reportRejected` contract `ReviewVerifier` follows (card 0250), reached
        // here partly by composition: `reviewOutcome`'s own failures (found-diff, provenance, verdict
        // consistency, unauthorized writes) already carry its verdict in `reviewOutcome.reportRejected`,
        // which is `false` only when one of them was a statement about the code (an empty diff).
        // Everything this method adds on top — a dropped or fabricated blocker, an empty refutation
        // reason, a criterion accounting mismatch — is itself a fault in this run's *own* report, so it
        // never flips this back to `false`. "Nothing to challenge" is the one exception: there is no
        // report to fault, the routing itself is wrong, so that branch returns before this applies.
        const codeFailure = reviewOutcome.failures.length > 0 && !reviewOutcome.reportRejected;

        const incoming = await this.incomingReview(cardId);
        if (incoming === undefined) {
            failures.push('nothing to challenge: the most recent review event for this card is not a stage.passed result with verdict "revise"');
            return { passed: false, failures, changedPaths: reviewOutcome.changedPaths };
        }

        const parsed = ChallengeResultSchema.safeParse(result);
        if (!parsed.success) {
            failures.push(`the reported result does not match the challenge schema: ${parsed.error.message}`);
            return {
                passed: false,
                failures,
                changedPaths: reviewOutcome.changedPaths,
                reportRejected: failures.length > 0 && !codeFailure,
            };
        }

        const { findings, refuted, criteria } = parsed.data;
        const upheld = findings.filter(finding => finding.severity === 'blocker');

        const incomingByKey = new Map<string, string>();
        for (const blocker of incoming.blockers) incomingByKey.set(normalize(blocker.problem), blocker.problem);

        const seenCounts = new Map<string, number>();
        const account = (problem: string): string => {
            const key = normalize(problem);
            seenCounts.set(key, (seenCounts.get(key) ?? 0) + 1);
            return key;
        };

        for (const finding of upheld) {
            const key = account(finding.problem);
            if (!incomingByKey.has(key)) {
                failures.push(`findings upholds blocker "${finding.problem}", which was not among the incoming blockers`);
            }
        }

        for (const entry of refuted) {
            const key = account(entry.problem);
            if (!incomingByKey.has(key)) {
                failures.push(`refuted cites "${entry.problem}", which was not among the incoming blockers`);
            }
            if (entry.reason.trim().length === 0) {
                failures.push(`refuted entry for "${entry.problem}" has an empty reason`);
            }
        }

        for (const [key, problem] of incomingByKey) {
            const count = seenCounts.get(key) ?? 0;
            if (count === 0) {
                failures.push(`incoming blocker "${problem}" was neither upheld in findings nor refuted`);
            } else if (count > 1) {
                failures.push(`incoming blocker "${problem}" appears more than once across findings and refuted`);
            }
        }

        // Every criterion ID the incoming review reported must survive into this run's own `criteria`
        // exactly once, and the only status change challenge may make is turning an `unmet` into a
        // `met` — a refutation, which `ReviewVerifier`'s composed provenance check (already folded
        // into `reviewOutcome` above) then holds to real file-and-line evidence the same as any other
        // `met` criterion. Dropping an ID, duplicating one, or any other status change fails here,
        // named by ID, the same way a dropped or invented blocker fails above. An incoming review with
        // no criteria (a plan without acceptance criteria bullets) leaves this off entirely, matching
        // `ReviewVerifier`'s own plan-criteria check in that case.
        if (incoming.criteria.length > 0) {
            const incomingById = new Map(incoming.criteria.map(criterion => [criterion.id, criterion]));
            const seenIds = new Set<string>();

            for (const criterion of criteria) {
                const before = incomingById.get(criterion.id);
                if (before === undefined) {
                    failures.push(`criteria reports "${criterion.id}", which was not among the incoming review's criteria`);
                    continue;
                }
                if (seenIds.has(criterion.id)) {
                    failures.push(`criterion "${criterion.id}" is reported more than once`);
                    continue;
                }
                seenIds.add(criterion.id);

                const allowed = criterion.status === before.status || (before.status === 'unmet' && criterion.status === 'met');
                if (!allowed) {
                    failures.push(
                        `criterion "${criterion.id}" changed from "${before.status}" to "${criterion.status}", but challenge may only turn an "unmet" criterion into "met"`,
                    );
                }
            }

            for (const id of incomingById.keys()) {
                if (!seenIds.has(id)) {
                    failures.push(`criterion "${id}" from the incoming review is missing from this run's criteria`);
                }
            }
        }

        return {
            passed: failures.length === 0,
            failures,
            changedPaths: reviewOutcome.changedPaths,
            reportRejected: failures.length > 0 && !codeFailure,
        };
    }

    /**
     * The blocker findings and full criteria list from the most recent `review`-stage *outcome* event
     * — `transition.written` rows sharing `stage: 'review'` are skipped, see the class doc comment —
     * if, and only if, that event is `stage.passed` with a `verdict: 'revise'` result. `undefined`
     * covers every other case (no review event, `stage.failed`, unparseable `payload.result`, or
     * `verdict: 'pass'`) uniformly: the caller turns any of them into the same "nothing to challenge"
     * failure. `criteria` is returned exactly as review reported it, including empty for a plan with no
     * acceptance criteria bullets, so the caller can tell "nothing to carry forward" from "review
     * reported some".
     */
    private async incomingReview(cardId: string): Promise<{ blockers: ReviewFinding[]; criteria: ReviewCriterion[] } | undefined> {
        const rows = await this.events.tail(this.config.project, cardId);
        for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i]!;
            if (row.stage !== 'review') continue;
            // `StageDispatcher.writeTransition` stamps `transition.written` with `stage: stageName`
            // — the stage that just ran, i.e. `'review'` — and appends it *after* that run's own
            // `stage.passed`/`stage.failed` event. On a card that actually just kicked back from
            // review, that transition record is therefore the most recent `'review'`-tagged row,
            // ahead of the outcome event this scan is looking for. Skipped rather than treated as
            // "not stage.passed", so the scan reaches the real outcome underneath it instead of
            // reporting "nothing to challenge" on every single kickback.
            if (row.type === 'transition.written') continue;
            if (row.type !== 'stage.passed') return undefined;
            const parsed = ReviewResultSchema.safeParse((row.payload as { result?: unknown }).result);
            if (!parsed.success || parsed.data.verdict !== 'revise') return undefined;
            return {
                blockers: parsed.data.findings.filter(finding => finding.severity === 'blocker'),
                criteria: parsed.data.criteria,
            };
        }
        return undefined;
    }
}
