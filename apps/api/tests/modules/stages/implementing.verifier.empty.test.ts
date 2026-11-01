import { describe, expect, it } from 'vitest';
import { ImplementingVerifier } from '#modules/stages/implementing.verifier.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import { stageDefaults } from '#tests/modules/stages/stage.fixture.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { Worktree } from '#modules/worktree/worktree.manager.js';

/**
 * Card 0182, decided 2026-09-02: accepted. The empty-diff rule stays — every exit condition an
 * agent can satisfy by doing less work is one it will eventually satisfy by doing less work — and
 * the refusal now tells the two cases apart, because they need opposite responses from an operator.
 *
 * "Did nothing" is an agent problem. "Nothing left to do" is a board problem: the branch already
 * carries this card's work, from a plan corrected mid-flight (card 0171) or a stage landed by hand,
 * and the answer is to move the card to the stage that still has work rather than to re-run this
 * one. `changedPaths` already distinguishes them and nothing was reading it here.
 *
 * Stubbed rather than driven against a real worktree: what is under test is which sentence the
 * verifier chooses from two path lists, not whether git reports them correctly — the worktree
 * manager's own tests cover that.
 */
const stage = (): StageConfig => ({
    ...stageDefaults,
    name: 'implementing',
    mode: 'agent',
    worktree: 'rw',
    provider: 'anthropic',
    model: 'claude-opus',
    instructions: 'do the thing',
    allowedCommands: [],
    worktreeFrom: 'base',
    extraScope: [],
    baselineCheck: true,
    maxSteps: 60,
    maxOutputTokens: 16000,
    onPass: 'testing',
    onFail: 'needs-human',
    maxKickbacks: 3,
});

const verifierWith = (changedPaths: string[], uncommittedPaths: string[]) =>
    new ImplementingVerifier({
        changedPaths: async () => changedPaths,
        uncommittedPaths: async () => uncommittedPaths,
    } as unknown as WorktreeManager);

const input = () => ({
    worktree: { path: '/nowhere', baseSha: 'abc123' } as Worktree,
    scope: { check: async () => ({ allowed: true as const, path: 'x', via: 'scope' as const }) },
    stage: stage(),
});

describe('ImplementingVerifier — an empty diff has two causes', () => {
    it('names the agent when the branch carries nothing either: the stage genuinely did nothing', async () => {
        const outcome = await verifierWith([], []).verify(input() as never);

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toContain('the diff is empty: the stage changed nothing');
    });

    it('names the board when the branch already carries the card’s work, and still fails', async () => {
        const outcome = await verifierWith(['src/a.ts', 'src/b.ts'], []).verify(input() as never);

        // The verdict does not change — card 0182 was accepted, not fixed.
        expect(outcome.passed).toBe(false);
        const [failure] = outcome.failures;
        expect(failure).toContain('2 file(s) of this card');
        expect(failure).toContain('move the card to the stage that still has work');
        expect(failure).not.toContain('the stage changed nothing');
    });

    it('says nothing about an empty diff when the stage did write', async () => {
        const outcome = await verifierWith(['src/a.ts'], ['src/a.ts']).verify(input() as never);

        expect(outcome.failures.some(f => f.includes('empty') || f.includes('wrote nothing'))).toBe(false);
    });
});
