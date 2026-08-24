import { describe, expect, it } from 'vitest';
import { decideChain } from '#modules/jobs/chain.decision.js';
import type { ProjectStages, StageConfig } from '#modules/stages/stage.config.js';

const makeStage = (overrides: Partial<StageConfig> = {}): StageConfig => ({
    name: 'testing',
    mode: 'agent',
    worktree: 'rw',
    provider: 'anthropic',
    model: 'claude-opus',
    instructions: 'test the thing',
    allowedCommands: [],
    worktreeFrom: 'branch',
    extraScope: [],
    baselineCheck: true,
    maxSteps: 60,
    maxOutputTokens: 16000,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
    ...overrides,
});

const stages = (overrides: Partial<StageConfig>[] = []): ProjectStages => ({
    scopeViolation: 'widen',
    alwaysAllowed: [],
    deny: [],
    stages: overrides.length ? overrides.map(o => makeStage(o)) : [makeStage()],
});

describe('decideChain', () => {
    it('stops the chain at every terminal state without consulting stage config', () => {
        for (const target of ['parking-lot', 'merged', 'needs-human', 'poisoned', 'dropped']) {
            const decision = decideChain(target, stages([]));
            expect(decision.continue).toBe(false);
            expect(decision.reason).toContain('terminal state');
        }
    });

    it('stops the chain when the target names no configured stage', () => {
        const decision = decideChain('nonexistent', stages([makeStage({ name: 'testing' })]));

        expect(decision.continue).toBe(false);
        expect(decision.reason).toContain('not a configured stage');
    });

    it('stops the chain at a manual stage', () => {
        const decision = decideChain('review', stages([makeStage({ name: 'review', mode: 'manual' })]));

        expect(decision.continue).toBe(false);
        expect(decision.reason).toContain('review');
        expect(decision.reason).toContain('manual');
    });

    it('stops the chain at a command stage', () => {
        const decision = decideChain('lint', stages([makeStage({ name: 'lint', mode: 'command' })]));

        expect(decision.continue).toBe(false);
        expect(decision.reason).toContain('command');
    });

    it('continues the chain into an agent stage, without a reason', () => {
        const decision = decideChain('testing', stages([makeStage({ name: 'testing', mode: 'agent' })]));

        expect(decision).toEqual({ continue: true });
    });

    it('continues the chain on a kickback target, even though it is "backward"', () => {
        const decision = decideChain(
            'implementing',
            stages([makeStage({ name: 'implementing', mode: 'agent' }), makeStage({ name: 'testing', mode: 'agent', onFail: 'implementing' })]),
        );

        expect(decision).toEqual({ continue: true });
    });

    // Card 0054: the guards learn about the flag. This is the check that prevents the spend loop the
    // next card would otherwise open: once an exhausted stage can leave a card in place instead of
    // routing it to `needs-human`, `target` is the same configured agent stage the card was already
    // failing in, and without this check first, the chain would re-enqueue it forever.
    describe('needsHuman', () => {
        it('stops the chain when needsHuman is true, even though the target is a perfectly valid, configured agent stage', () => {
            const decision = decideChain('implementing', stages([makeStage({ name: 'implementing', mode: 'agent' })]), { needsHuman: true });

            expect(decision.continue).toBe(false);
            expect(decision.reason).toContain('human');
        });

        it('checks needsHuman before the terminal-state check, so a flagged terminal target still names the flag', () => {
            const decision = decideChain('merged', stages([]), { needsHuman: true });

            expect(decision.continue).toBe(false);
            expect(decision.reason).toContain('human');
            expect(decision.reason).not.toContain('terminal state');
        });

        it('checks needsHuman before the stage-lookup check, so a flagged nonexistent target still names the flag', () => {
            const decision = decideChain('nonexistent', stages([makeStage({ name: 'testing' })]), { needsHuman: true });

            expect(decision.continue).toBe(false);
            expect(decision.reason).toContain('human');
            expect(decision.reason).not.toContain('configured stage');
        });

        it('behaves exactly as it does with no options, for an empty options object', () => {
            const withEmpty = decideChain('testing', stages([makeStage({ name: 'testing', mode: 'agent' })]), {});
            const withNone = decideChain('testing', stages([makeStage({ name: 'testing', mode: 'agent' })]));

            expect(withEmpty).toEqual({ continue: true });
            expect(withNone).toEqual({ continue: true });
        });

        it('does not stop the chain when needsHuman is explicitly false', () => {
            const decision = decideChain('testing', stages([makeStage({ name: 'testing', mode: 'agent' })]), { needsHuman: false });

            expect(decision).toEqual({ continue: true });
        });
    });
});
