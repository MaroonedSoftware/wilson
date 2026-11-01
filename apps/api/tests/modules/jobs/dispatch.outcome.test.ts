import { describe, expect, it } from 'vitest';
import { classifyDispatchFailure } from '#modules/jobs/dispatch.outcome.js';
import { CONTEXT_OVERFLOW_REASON } from '#modules/stages/permanent.failure.js';
import { StageConfigError } from '#modules/stages/stage.config.js';
import { NotDispatchableError, RebaseConflictError } from '#modules/stages/stage.dispatcher.js';

/**
 * This was an `instanceof` ladder inside `CardStageJob.runStage` — the region four of the last ten
 * cards to touch that file edited. As a pure function it is testable without a live pg-boss, a board
 * or a dispatcher, the same way `chain.decision.ts` and `dispatchable.ts` already are.
 *
 * The order of the checks is the part worth pinning: `isPermanentFailure` matches on message text
 * because provider errors offer nothing better, and it must never get first look at an error this
 * codebase threw with a discriminant on it.
 */
describe('classifyDispatchFailure', () => {
    describe('NotDispatchableError, routed on its typed reason', () => {
        it('defers an unsatisfied dependency, carrying what it is waiting on', () => {
            const error = new NotDispatchableError({ kind: 'unsatisfied-dependency', outstanding: ['0007', '0008'] }, 'waiting on 0007, 0008');

            expect(classifyDispatchFailure(error)).toEqual({
                kind: 'defer',
                outstanding: ['0007', '0008'],
                reason: 'waiting on 0007, 0008',
            });
        });

        it('defers a card already flagged for a human without naming another card', () => {
            const error = new NotDispatchableError({ kind: 'needs-human' }, 'flagged for a human: scope too wide');

            expect(classifyDispatchFailure(error)).toEqual({ kind: 'defer-flagged', reason: 'flagged for a human: scope too wide' });
        });

        it('calls a job that arrived after the card finished stale, not poisoned', () => {
            const error = new NotDispatchableError({ kind: 'wrong-stage', actualStage: 'merged' }, 'card is on merged');

            expect(classifyDispatchFailure(error)).toEqual({ kind: 'stale', actualStage: 'merged' });
        });

        it('calls a job for a card a human moved to another live stage stale, not poisoned', () => {
            const error = new NotDispatchableError({ kind: 'wrong-stage', actualStage: 'implementing' }, 'card is on implementing');

            expect(classifyDispatchFailure(error)).toEqual({ kind: 'stale', actualStage: 'implementing' });
        });

        /**
         * The allowlist card 0101's review warned about: a reason kind added to `stage.dispatcher.ts`
         * without a branch here turns its card terminal. That is deliberate — loud rather than
         * silent — and this pins it so the behaviour cannot drift by accident.
         */
        it('poisons a reason kind it does not recognise', () => {
            const error = new NotDispatchableError({ kind: 'empty-scope' }, 'the plan names no files');

            expect(classifyDispatchFailure(error)).toMatchObject({ kind: 'poison', error });
        });
    });

    it('flags a rebase conflict, carrying the typed error its record needs', () => {
        const error = new RebaseConflictError('card/0042-thing', 'abc1234', 'src/a.ts');

        const outcome = classifyDispatchFailure(error);

        expect(outcome).toEqual({ kind: 'flag-rebase', error });
        expect(outcome.kind === 'flag-rebase' && outcome.error.branch).toBe('card/0042-thing');
    });

    /**
     * Card 0072. Before this card, an overflow's `invalid_request_error` class fell all the way
     * through to `isPermanentFailure` and poisoned the card — terminal, even though the stage is
     * recoverable by doing it differently next time. `isContextOverflow` is now checked ahead of
     * `isPermanentFailure`, so this must flag rather than poison, and every other malformed request
     * must still poison exactly as it did before.
     */
    describe('context-window overflow, routed ahead of isPermanentFailure', () => {
        it('flags a context overflow, naming the context window rather than the request', () => {
            const error = new Error(
                '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 220000 tokens > 200000 maximum"}}',
            );

            expect(classifyDispatchFailure(error)).toEqual({ kind: 'flag-context-overflow', reason: CONTEXT_OVERFLOW_REASON });
        });

        it('still poisons an invalid_request_error that is not an overflow', () => {
            const error = new Error(
                '{"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}',
            );

            expect(classifyDispatchFailure(error)).toMatchObject({ kind: 'poison', error });
        });
    });

    /**
     * Card 0031. `StageDispatcher.run` calls `loadStages` and `findStage` before `assertDispatchable`
     * ever runs, so a `StageConfigError` reaches this function directly — it is neither a
     * `NotDispatchableError` nor a `RebaseConflictError`, and before this card it fell all the way
     * through to `isPermanentFailure`'s message matching, matched no pattern (`no stage named` and
     * `could not read` are not in `PERMANENT`), and retried three times before dead-lettering with no
     * `stage.poisoned` event and no transition — exactly the bug this card fixes.
     */
    describe('StageConfigError, routed on its typed kind', () => {
        it('poisons a stage-not-found error', () => {
            const error = new StageConfigError('stage-not-found', 'no stage named "reviewing" in stages.yaml (have: implementing)');

            expect(classifyDispatchFailure(error)).toEqual({ kind: 'poison', error });
        });

        /**
         * A broken `stages.yaml` is true for every card that would load the same file, not a fact
         * about this one — poisoning it would strand a whole board of otherwise-fine cards behind one
         * config typo. `outstanding` must be absent (not an empty array): that field means "these
         * cards are in the way", and there is no per-card dependency list for a broken file.
         */
        it('defers a config-invalid error rather than poisoning it, naming no outstanding cards', () => {
            const error = new StageConfigError('config-invalid', 'could not read stages.yaml: ENOENT');

            const outcome = classifyDispatchFailure(error);

            expect(outcome).toEqual({ kind: 'defer', reason: 'could not read stages.yaml: ENOENT' });
            expect(outcome.kind === 'defer' && 'outstanding' in outcome).toBe(false);
        });

        /**
         * The same ordering contract `NotDispatchableError` already has: a `StageConfigError` whose
         * message happens to look like a permanent-failure pattern must still route on its typed
         * `kind`, never fall through to `isPermanentFailure`'s text matching.
         */
        it('defers a config-invalid error even when its message looks like a permanent provider failure', () => {
            const error = new StageConfigError('config-invalid', 'stages.yaml is not valid stage config: authentication_error at stages.0.model');

            expect(classifyDispatchFailure(error)).toMatchObject({ kind: 'defer' });
        });
    });

    describe('errors this codebase did not throw', () => {
        it('retries anything isPermanentFailure does not recognise', () => {
            expect(classifyDispatchFailure(new Error('socket hang up'))).toEqual({ kind: 'retry' });
        });

        it('poisons a permanent provider failure', () => {
            expect(classifyDispatchFailure(new Error('Your credit balance is too low'))).toMatchObject({ kind: 'poison' });
        });

        it('retries a thrown non-Error rather than assuming the worst about it', () => {
            expect(classifyDispatchFailure('just a string')).toEqual({ kind: 'retry' });
        });
    });

    /**
     * The ordering contract. A `NotDispatchableError` whose *message* would match
     * `isPermanentFailure` must still route on its discriminant: message matching is tuned for
     * provider errors and must never outrank a type this codebase attached itself.
     */
    it('routes a typed refusal on its type even when its message looks like a permanent failure', () => {
        const error = new NotDispatchableError(
            { kind: 'unsatisfied-dependency', outstanding: ['0009'] },
            'waiting on 0009 — your credit balance is too low',
        );

        expect(classifyDispatchFailure(error)).toMatchObject({ kind: 'defer' });
    });
});
