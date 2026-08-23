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
            stages([
                makeStage({ name: 'implementing', mode: 'agent' }),
                makeStage({ name: 'testing', mode: 'agent', onFail: 'implementing' }),
            ]),
        );

        expect(decision).toEqual({ continue: true });
    });
});
