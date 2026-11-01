import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReviewVerifier } from '#modules/stages/review.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { ScopeGuard } from '#modules/agent/scope.guard.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { Card } from '#modules/board/card.js';

const exec = promisify(execFile);

/**
 * Exercises `ReviewVerifier.verify` against a real git worktree, the same way
 * `testing.verifier.test.ts` exercises `TestingVerifier` — the checks under test are precisely what
 * git reports as changed versus merely present, so a mock would only prove the test agrees with
 * itself about that.
 *
 * Card 0101: a `defect` that cites a file outside the diff but present in the worktree is what card
 * 0079's reviewer produced for `release.command.ts` — an accurate finding, mislabelled. The verifier
 * must correct it rather than fail the stage over it, while a finding that cites a file nowhere in
 * the worktree — a genuine hallucination — must still fail exactly as before.
 */
describe('ReviewVerifier', () => {
    let codeRoot: string;
    let manager: WorktreeManager;
    let verifier: ReviewVerifier;
    let warnCalls: string[];
    const stage = {} as StageConfig;

    // A pinned card with no `Acceptance criteria` section — every pre-existing test in this file
    // exercises the defect/finding checks that predate card 0236, and must see exactly the same
    // behaviour a plan with no criteria bullets always got: `planCriteria.length === 0` skips the
    // whole criteria-accounting block in `ReviewVerifier.verify`.
    const blankCard: Card = {
        frontmatter: { id: '0001', title: 'thing', stage: 'review', dependsOn: [], retries: {} },
        sections: {},
        body: '## Goal\n\nDo the thing.',
    };

    /** A pinned card whose `Acceptance criteria` section is exactly `raw`, for the criteria tests below. */
    const cardWithCriteria = (raw: string): Card => ({
        ...blankCard,
        sections: { 'Acceptance criteria': raw },
    });

    const verifyInput = (worktree: Awaited<ReturnType<WorktreeManager['create']>>, result: unknown, card: Card = blankCard) => ({
        worktree,
        stage,
        cardId: '0001',
        scope: {} as ScopeGuard,
        card,
        result,
    });

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'review-verifier-'));
        codeRoot = join(base, 'code');
        await mkdir(join(codeRoot, 'src'), { recursive: true });

        // A file present from the start of the branch. The card's diff never touches it, but it is
        // a real file in the worktree — the file card 0079's reviewer cited stands in for it.
        await writeFile(join(codeRoot, 'src', 'kept.ts'), 'export const kept = 1;\nexport const kept2 = 2;\n', 'utf8');

        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
        const silentLogger = { info: () => {}, warn: (msg: string) => warnCalls.push(msg), error: () => {}, debug: () => {} };
        warnCalls = [];
        manager = new WorktreeManager(config, silentLogger as never);
        verifier = new ReviewVerifier(manager, silentLogger as never);
    });

    /** Commits a change to `src/changed.ts` on the worktree's branch, standing in for the card's diff. */
    const makeDiff = async (worktree: Awaited<ReturnType<WorktreeManager['create']>>) => {
        await writeFile(join(worktree.path, 'src', 'changed.ts'), 'export const a = 1;\nexport const b = 2;\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: worktree.path });
        await exec('git', ['commit', '-q', '-m', 'card diff'], { cwd: worktree.path });
    };

    it('corrects a defect that cites a file outside the diff but present in the worktree, instead of failing the stage', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await makeDiff(worktree);

        const finding = { severity: 'blocker', kind: 'defect', file: 'src/kept.ts', line: 2, problem: 'stale comment', suggestion: 'update it' };
        const result = { summary: 'reviewed', verdict: 'revise', findings: [finding] };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.failures).toEqual([]);
        expect(outcome.passed).toBe(true);
        // The finding itself is untouched by the correction — file, severity and text all survive.
        expect(finding.file).toBe('src/kept.ts');
        expect(finding.severity).toBe('blocker');
        expect(finding.problem).toBe('stale comment');
        expect(finding.suggestion).toBe('update it');
    });

    it('logs the reclassification', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await makeDiff(worktree);

        const result = {
            summary: 'reviewed',
            verdict: 'revise',
            findings: [{ severity: 'blocker', kind: 'defect', file: 'src/kept.ts', line: 2, problem: 'p', suggestion: 's' }],
        };

        await verifier.verify(verifyInput(worktree, result));

        const hit = warnCalls.find(msg => msg.includes('src/kept.ts'));
        expect(hit).toBeDefined();
        expect(hit).toMatch(/"defect"/);
        expect(hit).toMatch(/"omission"/);
    });

    it('still fails a defect citing a file that exists in neither the diff nor the worktree', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await makeDiff(worktree);

        const result = {
            summary: 'reviewed',
            verdict: 'revise',
            findings: [{ severity: 'blocker', kind: 'defect', file: 'src/missing.ts', line: 1, problem: 'p', suggestion: 's' }],
        };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toHaveLength(1);
        expect(outcome.failures[0]).toContain('src/missing.ts');
        expect(outcome.failures[0]).toContain("not in this card's diff");
        expect(outcome.failures[0]).toContain('report it as kind "omission"');
        expect(warnCalls).toEqual([]);
    });

    it('still fails a defect citing a real file in the diff with an out-of-range line, unchanged', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await makeDiff(worktree);

        const result = {
            summary: 'reviewed',
            verdict: 'revise',
            findings: [{ severity: 'blocker', kind: 'defect', file: 'src/changed.ts', line: 50, problem: 'p', suggestion: 's' }],
        };

        const outcome = await verifier.verify(verifyInput(worktree, result));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toHaveLength(1);
        expect(outcome.failures[0]).toContain('src/changed.ts:50');
        expect(outcome.failures[0]).toMatch(/has only 3 lines/);
        expect(warnCalls).toEqual([]);
    });

    // Card 0236: the criteria-accounting block reconciles a review's `criteria` against
    // `acceptanceCriteria(card)`. These are the runner's new checks; the rest of this file's tests
    // above prove the pre-existing defect/finding checks still work unchanged when the pinned card
    // has no `Acceptance criteria` section at all.
    describe('acceptance criteria accounting', () => {
        it('passes when a review accounts for every criterion the plan named, citing real lines', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);
            const card = cardWithCriteria('- AC1: does the thing\n- AC2: does the other thing');

            const result = {
                summary: 'reviewed',
                verdict: 'pass',
                findings: [],
                criteria: [
                    { id: 'AC1', status: 'met', file: 'src/changed.ts', line: 1, note: 'implemented' },
                    { id: 'AC2', status: 'met', file: 'src/changed.ts', line: 2, note: 'implemented' },
                ],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, card));

            expect(outcome.failures).toEqual([]);
            expect(outcome.passed).toBe(true);
        });

        it('fails and names the ID when a review omits a criterion the pinned plan named', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);
            const card = cardWithCriteria('- AC1: does the thing\n- AC2: does the other thing');

            const result = {
                summary: 'reviewed',
                verdict: 'pass',
                findings: [],
                criteria: [{ id: 'AC1', status: 'met', file: 'src/changed.ts', line: 1, note: 'implemented' }],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, card));

            expect(outcome.passed).toBe(false);
            expect(outcome.failures.some(f => f.includes('AC2') && f.toLowerCase().includes('missing'))).toBe(true);
        });

        it('fails an ID the review reports that the pinned plan never named', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);
            const card = cardWithCriteria('- AC1: does the thing');

            const result = {
                summary: 'reviewed',
                verdict: 'pass',
                findings: [],
                criteria: [
                    { id: 'AC1', status: 'met', file: 'src/changed.ts', line: 1, note: 'implemented' },
                    { id: 'AC9', status: 'met', file: 'src/changed.ts', line: 1, note: 'made up' },
                ],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, card));

            expect(outcome.passed).toBe(false);
            expect(outcome.failures.some(f => f.includes('AC9') && f.includes('not among'))).toBe(true);
        });

        it('fails a criterion ID reported more than once', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);
            const card = cardWithCriteria('- AC1: does the thing');

            const result = {
                summary: 'reviewed',
                verdict: 'pass',
                findings: [],
                criteria: [
                    { id: 'AC1', status: 'met', file: 'src/changed.ts', line: 1, note: 'implemented' },
                    { id: 'AC1', status: 'met', file: 'src/changed.ts', line: 2, note: 'again' },
                ],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, card));

            expect(outcome.passed).toBe(false);
            expect(outcome.failures.some(f => f.includes('AC1') && f.includes('more than once'))).toBe(true);
        });

        // Card 0250: a "met" criterion no longer has to cite the diff — "the existing suites pass
        // unchanged" is legitimate evidence a card never touched. What still has to be real is the
        // citation: `src/kept.ts` is outside the diff but is a real file in the worktree, with the
        // cited line within it, so this now verifies instead of failing.
        it('passes a "met" criterion citing a file outside the diff, so long as it exists in the worktree with the line in range', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);
            const card = cardWithCriteria('- AC1: does the thing');

            const result = {
                summary: 'reviewed',
                verdict: 'pass',
                findings: [],
                criteria: [{ id: 'AC1', status: 'met', file: 'src/kept.ts', line: 1, note: 'implemented' }],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, card));

            expect(outcome.failures).toEqual([]);
            expect(outcome.passed).toBe(true);
        });

        // Card 0250, AC2: the relaxed rule still requires the citation to be real. Unlike the old
        // diff-only check, a file that is outside the diff *and* nowhere in the worktree now fails
        // with its own message rather than the diff-membership one.
        it('still fails a "met" criterion citing a file that does not exist anywhere in the worktree', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);
            const card = cardWithCriteria('- AC1: does the thing');

            const result = {
                summary: 'reviewed',
                verdict: 'pass',
                findings: [],
                criteria: [{ id: 'AC1', status: 'met', file: 'src/nowhere.ts', line: 1, note: 'implemented' }],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, card));

            expect(outcome.passed).toBe(false);
            expect(
                outcome.failures.some(f => f.includes('AC1') && f.includes('src/nowhere.ts') && f.includes('does not exist in the worktree')),
            ).toBe(true);
        });

        // Card 0250, AC2: a real file outside the diff with a line past its end still fails, now with
        // the "has only N lines" message rather than the old diff-membership one.
        it('still fails a "met" criterion citing a file outside the diff whose line is past the end of the file', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);
            const card = cardWithCriteria('- AC1: does the thing');

            const result = {
                summary: 'reviewed',
                verdict: 'pass',
                findings: [],
                criteria: [{ id: 'AC1', status: 'met', file: 'src/kept.ts', line: 99, note: 'implemented' }],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, card));

            expect(outcome.passed).toBe(false);
            expect(outcome.failures.some(f => f.includes('AC1') && f.includes('src/kept.ts:99') && f.includes('has only 3 lines'))).toBe(true);
        });

        it('fails a "met" criterion citing a line past the end of the file', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);
            const card = cardWithCriteria('- AC1: does the thing');

            const result = {
                summary: 'reviewed',
                verdict: 'pass',
                findings: [],
                criteria: [{ id: 'AC1', status: 'met', file: 'src/changed.ts', line: 99, note: 'implemented' }],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, card));

            expect(outcome.passed).toBe(false);
            expect(outcome.failures.some(f => f.includes('AC1') && f.includes('src/changed.ts:99') && f.includes('has only 3 lines'))).toBe(true);
        });

        it('fails "pass" when any criterion is "unmet"', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);
            const card = cardWithCriteria('- AC1: does the thing');

            const result = {
                summary: 'reviewed',
                verdict: 'pass',
                findings: [],
                criteria: [{ id: 'AC1', status: 'unmet', note: 'never implemented' }],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, card));

            expect(outcome.passed).toBe(false);
            expect(outcome.failures.some(f => f.includes('"pass"') && f.includes('unmet'))).toBe(true);
        });

        it('fails "revise" when there is no blocker finding and no "unmet" criterion', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);
            const card = cardWithCriteria('- AC1: does the thing');

            const result = {
                summary: 'reviewed',
                verdict: 'revise',
                findings: [],
                criteria: [{ id: 'AC1', status: 'met', file: 'src/changed.ts', line: 1, note: 'implemented' }],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, card));

            expect(outcome.passed).toBe(false);
            expect(outcome.failures.some(f => f.includes('"revise"') && f.includes('blocker') && f.includes('unmet'))).toBe(true);
        });

        it('passes "revise" backed only by an "unmet" criterion, with no blocker finding', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);
            const card = cardWithCriteria('- AC1: does the thing');

            const result = {
                summary: 'reviewed',
                verdict: 'revise',
                findings: [],
                criteria: [{ id: 'AC1', status: 'unmet', note: 'never implemented' }],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, card));

            expect(outcome.failures).toEqual([]);
            expect(outcome.passed).toBe(true);
        });

        it('skips the whole criteria check when the pinned plan has no Acceptance criteria bullets, even if the result reports one', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);

            const result = {
                summary: 'reviewed',
                verdict: 'pass',
                findings: [],
                criteria: [{ id: 'AC9', status: 'met', file: 'src/kept.ts', line: 999, note: 'a criterion for a plan with none' }],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, blankCard));

            expect(outcome.failures).toEqual([]);
            expect(outcome.passed).toBe(true);
        });

        it('parses and verifies a result that omits the criteria field entirely, exactly as before this field existed', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);
            const card = cardWithCriteria('- AC1: does the thing');

            // No `criteria` key at all — `ReviewResultSchema` defaults it to `[]`, which then reads
            // as "every plan criterion missing" once the plan actually has one.
            const result = { summary: 'reviewed', verdict: 'pass', findings: [] };

            const outcome = await verifier.verify(verifyInput(worktree, result, card));

            expect(outcome.passed).toBe(false);
            expect(outcome.failures.some(f => f.includes('AC1') && f.toLowerCase().includes('missing'))).toBe(true);
        });
    });

    /**
     * Card 0250, AC4/AC5: `reportRejected` tells `StageDispatcher.runAgent` whether a failing review
     * has anything for `onFail`'s next stage to act on. It must be `true` when every failure is a
     * fault in the review's own report, and stay falsy when the empty-diff check — a statement about
     * the card's code, not the report — is among the failures.
     */
    describe('reportRejected', () => {
        it("is true when every failure is a fault in the review's own report", async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            await makeDiff(worktree);
            const card = cardWithCriteria('- AC1: does the thing');

            // A duplicate criterion ID is purely a report-accounting fault: the diff is real, the
            // criterion's own citation is fine, and nothing here is a statement about the code.
            const result = {
                summary: 'reviewed',
                verdict: 'pass',
                findings: [],
                criteria: [
                    { id: 'AC1', status: 'met', file: 'src/changed.ts', line: 1, note: 'implemented' },
                    { id: 'AC1', status: 'met', file: 'src/changed.ts', line: 2, note: 'again' },
                ],
            };

            const outcome = await verifier.verify(verifyInput(worktree, result, card));

            expect(outcome.passed).toBe(false);
            expect(outcome.reportRejected).toBe(true);
        });

        it('is false when the card has an empty diff, since that is a statement about the code, not the report', async () => {
            const worktree = await manager.create('0001', 'card/0001-thing');
            // No `makeDiff` call: the worktree's diff from the fork point is empty.

            const result = { summary: 'reviewed', verdict: 'pass', findings: [], criteria: [] };

            const outcome = await verifier.verify(verifyInput(worktree, result));

            expect(outcome.passed).toBe(false);
            expect(outcome.failures.some(f => f.includes('empty diff'))).toBe(true);
            expect(outcome.reportRejected).toBe(false);
        });
    });
});
