import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChallengeVerifier } from '#modules/stages/challenge.verifier.js';
import { ReviewVerifier } from '#modules/stages/review.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { ScopeGuard } from '#modules/agent/scope.guard.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { CardEventRow, EventLog } from '#modules/events/event.log.js';
import type { ReviewCriterion, ReviewFinding } from '#modules/stages/stage.result.js';
import type { Card } from '#modules/board/card.js';

const exec = promisify(execFile);

/**
 * Card 0237: `ChallengeVerifier` composes `ReviewVerifier` — no writes, real provenance, verdict
 * consistency — and adds its own accounting rule on top: every blocker the *incoming* review raised
 * must appear exactly once, either upheld in `findings` or refuted with a non-empty reason.
 *
 * Exercised against a real git worktree, the same way `review.verifier.test.ts` exercises
 * `ReviewVerifier` itself — a mock of `changedPaths`/`uncommittedPaths` would only prove the test
 * agrees with itself about what those mean. `EventLog` is faked, since what matters here is what
 * `ChallengeVerifier` does with `tail`'s answer, not `tail`'s own query — that is `event.log.test.ts`'s
 * job.
 */
describe('ChallengeVerifier', () => {
    let codeRoot: string;
    let manager: WorktreeManager;
    let reviewVerifier: ReviewVerifier;
    const stage = {} as StageConfig;
    const cardId = '0001';

    // No `Acceptance criteria` section — `ReviewVerifier.verify` (which `ChallengeVerifier` composes
    // by forwarding this same input) skips its card-0236 criteria-accounting block entirely, so this
    // file's pre-existing challenge-accounting checks run exactly as they did before that block existed.
    const card: Card = {
        frontmatter: { id: cardId, title: 'thing', stage: 'challenge', dependsOn: [], retries: {} },
        sections: {},
        body: '## Goal\n\nDo the thing.',
    };

    const verifyInput = (worktree: Awaited<ReturnType<WorktreeManager['create']>>, result: unknown, cardOverride: Card = card) => ({
        worktree,
        stage,
        cardId,
        scope: {} as ScopeGuard,
        card: cardOverride,
        result,
    });

    /**
     * A pinned card whose `Acceptance criteria` section is exactly `raw` — only needed for the tests
     * below that exercise the composed `ReviewVerifier`'s "met" provenance check on a criterion,
     * which reads the *plan's own* section (`acceptanceCriteria(card)`), not the incoming review's
     * `criteria` list that `ChallengeVerifier` itself carries forward.
     */
    const cardWithCriteria = (raw: string): Card => ({ ...card, sections: { 'Acceptance criteria': raw } });

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'challenge-verifier-'));
        codeRoot = join(base, 'code');
        await mkdir(join(codeRoot, 'src'), { recursive: true });
        // Git tracks files, not directories: without a tracked file already under `src/`, a fresh
        // worktree checkout has no `src` directory at all for `makeDiff` to write into.
        await writeFile(join(codeRoot, 'src', 'kept.ts'), 'export const kept = 1;\n', 'utf8');

        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
        const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
        manager = new WorktreeManager(config, silentLogger as never);
        reviewVerifier = new ReviewVerifier(manager, silentLogger as never);
    });

    /** Commits a five-line `src/changed.ts` to the worktree's branch, standing in for the card's diff. */
    const makeDiff = async (worktree: Awaited<ReturnType<WorktreeManager['create']>>) => {
        await writeFile(join(worktree.path, 'src', 'changed.ts'), 'a\nb\nc\nd\ne\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: worktree.path });
        await exec('git', ['commit', '-q', '-m', 'card diff'], { cwd: worktree.path });
    };

    /** One `stage.passed` review event carrying the given findings, as `EventLog.tail` would return it. */
    const reviewPassedEvent = (findings: unknown[], verdict: 'pass' | 'revise' = 'revise'): CardEventRow => ({
        id: '1',
        stage: 'review',
        type: 'stage.passed',
        payload: { result: { summary: 'reviewed', verdict, findings } },
        createdAt: DateTime.now(),
    });

    const blocker = (problem: string, overrides: Partial<ReviewFinding> = {}) => ({
        severity: 'blocker' as const,
        kind: 'defect' as const,
        file: 'src/changed.ts',
        line: 2,
        problem,
        suggestion: 'fix it',
        ...overrides,
    });

    const concern = (problem: string, overrides: Partial<ReviewFinding> = {}) => ({
        severity: 'concern' as const,
        kind: 'defect' as const,
        file: 'src/changed.ts',
        line: 3,
        problem,
        suggestion: 'consider it',
        ...overrides,
    });

    /** One `stage.passed` review event carrying both findings and criteria, as `EventLog.tail` would return it. */
    const reviewPassedEventWithCriteria = (findings: unknown[], criteria: unknown[], verdict: 'pass' | 'revise' = 'revise'): CardEventRow => ({
        id: '1',
        stage: 'review',
        type: 'stage.passed',
        payload: { result: { summary: 'reviewed', verdict, findings, criteria } },
        createdAt: DateTime.now(),
    });

    const metCriterion = (id: string, overrides: Partial<ReviewCriterion> = {}) => ({
        id,
        status: 'met' as const,
        file: 'src/changed.ts',
        line: 2,
        note: 'implemented',
        ...overrides,
    });

    const unmetCriterion = (id: string, overrides: Partial<ReviewCriterion> = {}) => ({
        id,
        status: 'unmet' as const,
        note: 'not yet implemented',
        ...overrides,
    });

    /** Builds a `ChallengeVerifier` whose `EventLog.tail` answers with exactly `rows`. */
    const buildVerifier = (rows: CardEventRow[]): ChallengeVerifier => {
        const events = { tail: async () => rows } as unknown as EventLog;
        const config = new StaticBoardConfig('test', codeRoot, join(codeRoot, '..', 'worktrees'), join(codeRoot, '..', 'run'));
        return new ChallengeVerifier(reviewVerifier, events, config);
    };

    // AC1
    it('verifies a result that refutes the one incoming blocker, with a non-empty reason', async () => {
        const worktree = await manager.create(cardId, 'card/0001-thing');
        await makeDiff(worktree);
        const verifier = buildVerifier([reviewPassedEvent([blocker('the loop bound is off by one')])]);

        const result = {
            summary: 'challenged',
            verdict: 'pass',
            findings: [],
            refuted: [{ problem: 'the loop bound is off by one', reason: 'the diff shows the bound is inclusive on purpose' }],
        };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.failures).toEqual([]);
        expect(outcome.passed).toBe(true);
    });

    // AC1, normalization: a reformatted problem string (extra whitespace, different case) still
    // matches the incoming blocker it refutes — `normalize`'s whole reason for existing.
    it('matches a refuted problem to its incoming blocker despite whitespace and case differences', async () => {
        const worktree = await manager.create(cardId, 'card/0001-thing');
        await makeDiff(worktree);
        const verifier = buildVerifier([reviewPassedEvent([blocker('The   Loop Bound is off by one')])]);

        const result = {
            summary: 'challenged',
            verdict: 'pass',
            findings: [],
            refuted: [{ problem: 'the loop bound is off by one', reason: 'not actually a bug' }],
        };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.passed).toBe(true);
        expect(outcome.failures).toEqual([]);
    });

    // AC2
    it('verifies a result that upholds the one incoming blocker', async () => {
        const worktree = await manager.create(cardId, 'card/0001-thing');
        await makeDiff(worktree);
        const theBlocker = blocker('genuinely still wrong');
        const verifier = buildVerifier([reviewPassedEvent([theBlocker])]);

        const result = { summary: 'challenged', verdict: 'revise', findings: [theBlocker], refuted: [] };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.failures).toEqual([]);
        expect(outcome.passed).toBe(true);
    });

    // AC3
    it('fails, naming the blocker, when a result neither upholds nor refutes an incoming blocker', async () => {
        const worktree = await manager.create(cardId, 'card/0001-thing');
        await makeDiff(worktree);
        const verifier = buildVerifier([reviewPassedEvent([blocker('a blocker nobody answered')])]);

        const result = { summary: 'challenged', verdict: 'pass', findings: [], refuted: [] };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('a blocker nobody answered') && f.includes('neither upheld'))).toBe(true);
    });

    // AC4
    it('fails when a result upholds a blocker that was never incoming', async () => {
        const worktree = await manager.create(cardId, 'card/0001-thing');
        await makeDiff(worktree);
        // A "revise" review with no blocker findings is unusual, but the incoming list is what it
        // is: empty. `ReviewResultSchema` itself carries no verdict/blocker consistency refinement —
        // that check is `ReviewVerifier`'s own, run at review time, not re-validated on the way in
        // here.
        const verifier = buildVerifier([reviewPassedEvent([])]);

        const fabricated = blocker('this was never raised by the review');
        const result = { summary: 'challenged', verdict: 'revise', findings: [fabricated], refuted: [] };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('this was never raised by the review') && f.includes('not among the incoming'))).toBe(true);
    });

    // AC5, no prior review event at all
    it('fails with "nothing to challenge" when there is no prior review event', async () => {
        const worktree = await manager.create(cardId, 'card/0001-thing');
        await makeDiff(worktree);
        const verifier = buildVerifier([]);

        const outcome = await verifier.verify(verifyInput(worktree, { summary: 'x', verdict: 'pass', findings: [], refuted: [] }));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('nothing to challenge'))).toBe(true);
    });

    // AC5, the most recent review event failed rather than passed
    it('fails with "nothing to challenge" when the most recent review event is stage.failed', async () => {
        const worktree = await manager.create(cardId, 'card/0001-thing');
        await makeDiff(worktree);
        const failedReview: CardEventRow = {
            id: '1',
            stage: 'review',
            type: 'stage.failed',
            payload: { result: { summary: 'reviewed', verdict: 'revise', findings: [blocker('x')] } },
            createdAt: DateTime.now(),
        };
        const verifier = buildVerifier([failedReview]);

        const outcome = await verifier.verify(verifyInput(worktree, { summary: 'x', verdict: 'pass', findings: [], refuted: [] }));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('nothing to challenge'))).toBe(true);
    });

    // AC5, a passed review whose own verdict was "pass" (no blocker to challenge in the first place)
    it('fails with "nothing to challenge" when the most recent review event passed with verdict "pass"', async () => {
        const worktree = await manager.create(cardId, 'card/0001-thing');
        await makeDiff(worktree);
        const verifier = buildVerifier([reviewPassedEvent([], 'pass')]);

        const outcome = await verifier.verify(verifyInput(worktree, { summary: 'x', verdict: 'pass', findings: [], refuted: [] }));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('nothing to challenge'))).toBe(true);
    });

    // AC6
    it('fails any write to the worktree, exactly as it does for review', async () => {
        const worktree = await manager.create(cardId, 'card/0001-thing');
        await makeDiff(worktree);
        const verifier = buildVerifier([reviewPassedEvent([blocker('a real blocker')])]);

        // The challenge stage judges, it does not edit — writing here stands in for a challenger
        // that mutated the worktree, which `ReviewVerifier`'s composed "no writes" check must catch.
        await writeFile(join(worktree.path, 'src', 'changed.ts'), 'a\nb\nc\nd\ne\nf\n', 'utf8');

        const result = {
            summary: 'challenged',
            verdict: 'pass',
            findings: [],
            refuted: [{ problem: 'a real blocker', reason: 'not a real bug' }],
        };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('changed files') && f.includes('must not do'))).toBe(true);
    });

    // AC7
    it('fails a refuted entry with an empty reason', async () => {
        const worktree = await manager.create(cardId, 'card/0001-thing');
        await makeDiff(worktree);
        const verifier = buildVerifier([reviewPassedEvent([blocker('needs a real reason')])]);

        const result = {
            summary: 'challenged',
            verdict: 'pass',
            findings: [],
            refuted: [{ problem: 'needs a real reason', reason: '   ' }],
        };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('needs a real reason') && f.includes('empty reason'))).toBe(true);
    });

    // The accounting rule extends past one blocker: two incoming, one upheld and one refuted,
    // together account for both.
    it('verifies a result that upholds one incoming blocker and refutes the other', async () => {
        const worktree = await manager.create(cardId, 'card/0001-thing');
        await makeDiff(worktree);
        const upheldBlocker = blocker('still wrong', { line: 2 });
        const refutedBlocker = blocker('not actually wrong', { line: 4 });
        const verifier = buildVerifier([reviewPassedEvent([upheldBlocker, refutedBlocker])]);

        const result = {
            summary: 'challenged',
            verdict: 'revise',
            findings: [upheldBlocker],
            refuted: [{ problem: 'not actually wrong', reason: 'the diff already handles this case' }],
        };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.failures).toEqual([]);
        expect(outcome.passed).toBe(true);
    });

    // Concerns are not blockers, and the accounting rule never asks about them: an incoming concern
    // left untouched — neither upheld nor refuted — must not fail the stage the way an unanswered
    // blocker does.
    it('does not require an incoming concern to be accounted for', async () => {
        const worktree = await manager.create(cardId, 'card/0001-thing');
        await makeDiff(worktree);
        const verifier = buildVerifier([reviewPassedEvent([blocker('the one real blocker'), concern('a mere concern')])]);

        const result = {
            summary: 'challenged',
            verdict: 'pass',
            findings: [],
            refuted: [{ problem: 'the one real blocker', reason: 'not a real bug' }],
        };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.failures).toEqual([]);
        expect(outcome.passed).toBe(true);
    });

    // A blocker cited twice — once upheld, once also refuted — is accounted for more than once,
    // which is exactly as wrong as not accounting for it at all: the count matters, not just
    // presence.
    it('fails when an incoming blocker is both upheld and refuted', async () => {
        const worktree = await manager.create(cardId, 'card/0001-thing');
        await makeDiff(worktree);
        const theBlocker = blocker('double counted');
        const verifier = buildVerifier([reviewPassedEvent([theBlocker])]);

        const result = {
            summary: 'challenged',
            verdict: 'revise',
            findings: [theBlocker],
            refuted: [{ problem: 'double counted', reason: 'also refuting it for good measure' }],
        };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('double counted') && f.includes('more than once'))).toBe(true);
    });

    /**
     * Card 0243: challenge carries every incoming criterion ID forward, may only turn an `unmet` into
     * `met` with evidence, and its verdict rule counts an `unmet` criterion the same as an upheld
     * blocker — the same rule `ReviewVerifier` applies post-0236, reached here purely through
     * composition (`ChallengeVerifier.verify` never states a verdict rule of its own).
     */
    describe('carrying acceptance criteria forward', () => {
        // AC1
        it('verifies when every incoming blocker is refuted and the one unmet criterion is turned met with evidence', async () => {
            const worktree = await manager.create(cardId, 'card/0001-thing');
            await makeDiff(worktree);
            const planCard = cardWithCriteria('- AC1: does the thing');
            const verifier = buildVerifier([reviewPassedEventWithCriteria([blocker('needs work')], [unmetCriterion('AC1')])]);

            const result = {
                summary: 'challenged',
                verdict: 'pass',
                findings: [],
                refuted: [{ problem: 'needs work', reason: 'already handled' }],
                criteria: [metCriterion('AC1')],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, planCard));

            expect(outcome.failures).toEqual([]);
            expect(outcome.passed).toBe(true);
        });

        // AC2: blockers refuted, one criterion still unmet, verdict revise verifies...
        it('verifies a "revise" verdict when every blocker is refuted but a criterion is still unmet', async () => {
            const worktree = await manager.create(cardId, 'card/0001-thing');
            await makeDiff(worktree);
            const verifier = buildVerifier([reviewPassedEventWithCriteria([blocker('needs work')], [unmetCriterion('AC1')])]);

            const result = {
                summary: 'challenged',
                verdict: 'revise',
                findings: [],
                refuted: [{ problem: 'needs work', reason: 'already handled' }],
                criteria: [unmetCriterion('AC1')],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result));

            expect(outcome.failures).toEqual([]);
            expect(outcome.passed).toBe(true);
        });

        // AC2: ...the same with verdict "pass" fails, since the composed ReviewVerifier's post-0236
        // consistency check counts an unmet criterion the same as an upheld blocker.
        it('fails a "pass" verdict when a criterion is still unmet, even with every blocker refuted', async () => {
            const worktree = await manager.create(cardId, 'card/0001-thing');
            await makeDiff(worktree);
            const verifier = buildVerifier([reviewPassedEventWithCriteria([blocker('needs work')], [unmetCriterion('AC1')])]);

            const result = {
                summary: 'challenged',
                verdict: 'pass',
                findings: [],
                refuted: [{ problem: 'needs work', reason: 'already handled' }],
                criteria: [unmetCriterion('AC1')],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result));

            expect(outcome.passed).toBe(false);
            expect(outcome.failures.some(f => f.includes('"pass"') && f.includes('unmet'))).toBe(true);
        });

        // Card 0250: the composed ReviewVerifier provenance check no longer requires a "met"
        // criterion to cite the diff — only that the citation be real. `src/kept.ts` is outside the
        // diff but a genuine file in the worktree with the cited line in range, so turning AC1 "met"
        // with that citation now verifies, where it used to fail on the old diff-only rule.
        it('verifies when a criterion turned "met" cites a file outside the diff, so long as it exists in the worktree', async () => {
            const worktree = await manager.create(cardId, 'card/0001-thing');
            await makeDiff(worktree);
            const planCard = cardWithCriteria('- AC1: does the thing');
            const verifier = buildVerifier([reviewPassedEventWithCriteria([], [unmetCriterion('AC1')], 'revise')]);

            const result = {
                summary: 'challenged',
                verdict: 'pass',
                findings: [],
                refuted: [],
                criteria: [metCriterion('AC1', { file: 'src/kept.ts', line: 1 })],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, planCard));

            expect(outcome.failures).toEqual([]);
            expect(outcome.passed).toBe(true);
        });

        // Card 0250, AC2: the relaxed rule still requires the citation to be real — a file that
        // exists nowhere in the worktree still fails, now with its own message rather than the old
        // diff-membership one.
        it('still fails when a criterion turned "met" cites a file that does not exist anywhere in the worktree', async () => {
            const worktree = await manager.create(cardId, 'card/0001-thing');
            await makeDiff(worktree);
            const planCard = cardWithCriteria('- AC1: does the thing');
            const verifier = buildVerifier([reviewPassedEventWithCriteria([], [unmetCriterion('AC1')], 'revise')]);

            const result = {
                summary: 'challenged',
                verdict: 'pass',
                findings: [],
                refuted: [],
                criteria: [metCriterion('AC1', { file: 'src/nowhere.ts', line: 1 })],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, planCard));

            expect(outcome.passed).toBe(false);
            expect(
                outcome.failures.some(f => f.includes('AC1') && f.includes('src/nowhere.ts') && f.includes('does not exist in the worktree')),
            ).toBe(true);
        });

        // AC4
        it('fails, naming the ID, when a criterion review reported "met" comes back "unmet"', async () => {
            const worktree = await manager.create(cardId, 'card/0001-thing');
            await makeDiff(worktree);
            const verifier = buildVerifier([reviewPassedEventWithCriteria([], [metCriterion('AC1')])]);

            const result = {
                summary: 'challenged',
                verdict: 'revise',
                findings: [],
                refuted: [],
                criteria: [unmetCriterion('AC1')],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result));

            expect(outcome.passed).toBe(false);
            expect(outcome.failures.some(f => f.includes('AC1') && f.includes('"met"') && f.includes('"unmet"'))).toBe(true);
        });

        // AC5
        it('fails, naming the ID, when a challenge result drops a criterion the review reported', async () => {
            const worktree = await manager.create(cardId, 'card/0001-thing');
            await makeDiff(worktree);
            const verifier = buildVerifier([reviewPassedEventWithCriteria([], [unmetCriterion('AC1')])]);

            const result = { summary: 'challenged', verdict: 'pass', findings: [], refuted: [], criteria: [] };

            const outcome = await verifier.verify(verifyInput(worktree, result));

            expect(outcome.passed).toBe(false);
            expect(outcome.failures.some(f => f.includes('AC1') && f.includes('missing from this run'))).toBe(true);
        });

        // AC6: an incoming review with no criteria at all leaves the whole accounting block off, so a
        // challenge result carrying no `criteria` field either (`ChallengeResultSchema` defaults it to
        // `[]`, same as `ReviewResultSchema`) verifies exactly as it did before this card.
        it('verifies exactly as before when the incoming review reported no criteria', async () => {
            const worktree = await manager.create(cardId, 'card/0001-thing');
            await makeDiff(worktree);
            const theBlocker = blocker('genuinely still wrong');
            const verifier = buildVerifier([reviewPassedEventWithCriteria([theBlocker], [])]);

            const result = { summary: 'challenged', verdict: 'revise', findings: [theBlocker], refuted: [] };

            const outcome = await verifier.verify(verifyInput(worktree, result));

            expect(outcome.failures).toEqual([]);
            expect(outcome.passed).toBe(true);
        });
    });

    /**
     * Card 0250, AC6: `reportRejected` must be true when a challenge fails only on its own
     * accounting (this run's report), so `StageDispatcher` retries `challenge` instead of routing
     * through `challenge.onFail`. "Nothing to challenge" is the one case that is not a report fault —
     * there is no report to fault, the routing itself is wrong — so it must not set `reportRejected`.
     */
    describe('reportRejected', () => {
        it("is true when the only failure is this run's own accounting fault", async () => {
            const worktree = await manager.create(cardId, 'card/0001-thing');
            await makeDiff(worktree);
            const verifier = buildVerifier([reviewPassedEvent([blocker('needs a real reason')])]);

            // An empty refutation reason is purely a fault in this run's own report — the incoming
            // blocker is real and correctly matched, only the reason text is missing.
            const result = {
                summary: 'challenged',
                verdict: 'pass',
                findings: [],
                refuted: [{ problem: 'needs a real reason', reason: '   ' }],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result));

            expect(outcome.passed).toBe(false);
            expect(outcome.reportRejected).toBe(true);
        });

        it('is not set when there is nothing to challenge', async () => {
            const worktree = await manager.create(cardId, 'card/0001-thing');
            await makeDiff(worktree);
            const verifier = buildVerifier([]);

            const outcome = await verifier.verify(verifyInput(worktree, { summary: 'x', verdict: 'pass', findings: [], refuted: [] }));

            expect(outcome.passed).toBe(false);
            expect(outcome.failures.some(f => f.includes('nothing to challenge'))).toBe(true);
            expect(outcome.reportRejected).toBeFalsy();
        });
    });
});
