import { Injectable } from 'injectkit';
import { BoardConfig } from '#modules/board/board.config.js';
import { EventLog } from '#modules/events/event.log.js';
import { ChallengeResultSchema, ReviewResultSchema, type ReviewFinding } from './stage.result.js';
import { ReviewVerifier } from './review.verifier.js';
import type { StageVerifier, VerificationInput, VerificationOutcome } from './stage.verifier.js';

/** Whitespace-normalised, case-folded, so a reformatted blocker still matches its own review finding. */
const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The challenge stage's exit condition: does this run's report actually account for the blockers the
 * preceding review raised, refuting some and upholding the rest, rather than inventing or dropping
 * any of them.
 *
 * Composes `ReviewVerifier` for everything a review-shaped result already needs checked — no writes
 * (a challenger judges, it does not edit, same as a reviewer), every finding's provenance against the
 * diff, and `verdict`/blocker consistency — since `ChallengeResultSchema` is `ReviewResultSchema` plus
 * `refuted`, and `findings` here carries the same kind of blocker/concern entries a review reports.
 * What this class adds on top is the accounting rule that makes "challenge" mean something rather than
 * letting a run silently drop a blocker it had no answer for: every blocker the *incoming* review
 * raised must appear exactly once, either upheld in `findings` or refuted with a non-empty `reason` in
 * `refuted`, matched on `normalize(problem)` rather than `file`/`line` — the dispatcher rebases the
 * card's branch onto head before this stage runs, so a line number the review cited can have moved by
 * the time challenge reads it.
 *
 * The incoming blockers come from `EventLog.tail`, not the card body: `wilson card show`/the body's
 * rendered bullets print `file:undefined` for an omission finding, so parsing them back out would be
 * lossy in exactly the cases this stage most needs to get right. Specifically, the most recent
 * *stage-outcome* event on this card whose `stage` is `'review'` must be `stage.passed` and its
 * `payload.result` must parse as `ReviewResultSchema` with `verdict: 'revise'` — that is what
 * `review.onFail: challenge` routes here in the first place (a review with no blocker never fails its
 * own verifier's `verdict`/blocker consistency check the way `shouldAdvance`, `kickback.ts`, reads
 * it). "Stage-outcome" excludes `transition.written`: `StageDispatcher.writeTransition` stamps that
 * event with `stage: stageName` too, and appends it right after `stage.passed`/`stage.failed`, so on
 * a card that just kicked back it is the most recent `'review'`-tagged row of all — `incomingBlockers`
 * skips past it rather than reading it as "the review event", or this scan would report "nothing to
 * challenge" on every single kickback instead of the one it actually means. Anything else — no review
 * event at all, the most recent one `stage.failed`, or a `verdict` other than `'revise'` — means there
 * is nothing for this stage to do, so `verify` fails with "nothing to challenge" rather than running
 * the accounting check against an empty or wrong blocker list. That failure routes through
 * `challenge.onFail` to `implementing`, which is today's behaviour for a `revise` review before this
 * card — this stage is a detour in front of it, not a replacement.
 *
 * Two known limitations, left for a later card:
 *
 * - The `cli` adapter ignores `stage.model` (see that adapter's own doc comment), so a `challenge`
 *   stage configured with it runs on the engine's default model, not a cheaper one picked for this
 *   lighter-weight task. Passing `stage.model` through the `cli` adapter is out of this card's scope;
 *   a board that wants a cheaper challenge model needs `adapter: api` instead.
 * - Review's own `maxKickbacks`-th `revise` flags the card for a human before `onFail` is consulted
 *   (`kickback.ts`), so that last round never reaches `challenge` — the blockers on it are never
 *   refuted, however weak they might be.
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

        const incoming = await this.incomingBlockers(cardId);
        if (incoming === undefined) {
            failures.push(
                'nothing to challenge: the most recent review event for this card is not a stage.passed result with verdict "revise"',
            );
            return { passed: false, failures, changedPaths: reviewOutcome.changedPaths };
        }

        const parsed = ChallengeResultSchema.safeParse(result);
        if (!parsed.success) {
            failures.push(`the reported result does not match the challenge schema: ${parsed.error.message}`);
            return { passed: false, failures, changedPaths: reviewOutcome.changedPaths };
        }

        const { findings, refuted } = parsed.data;
        const upheld = findings.filter(finding => finding.severity === 'blocker');

        const incomingByKey = new Map<string, string>();
        for (const blocker of incoming) incomingByKey.set(normalize(blocker.problem), blocker.problem);

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

        return { passed: failures.length === 0, failures, changedPaths: reviewOutcome.changedPaths };
    }

    /**
     * The blocker findings from the most recent `review`-stage *outcome* event — `transition.written`
     * rows sharing `stage: 'review'` are skipped, see the class doc comment — if, and only if, that
     * event is `stage.passed` with a `verdict: 'revise'` result. `undefined` covers every other case
     * (no review event, `stage.failed`, unparseable `payload.result`, or `verdict: 'pass'`) uniformly:
     * the caller turns any of them into the same "nothing to challenge" failure.
     */
    private async incomingBlockers(cardId: string): Promise<ReviewFinding[] | undefined> {
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
            return parsed.data.findings.filter(finding => finding.severity === 'blocker');
        }
        return undefined;
    }
}
