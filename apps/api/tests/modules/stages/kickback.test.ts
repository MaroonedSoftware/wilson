import { describe, expect, it } from 'vitest';
import { kickback } from '#modules/stages/kickback.js';
import type { StageConfig } from '#modules/stages/stage.config.js';

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

describe('kickback', () => {
    it('increments the counter for the failing stage from an absent count', () => {
        const stage = makeStage();
        const decision = kickback(stage, {});

        expect(decision.retries).toEqual({ testing: 1 });
    });

    it('routes to onFail while the stage has failed fewer than maxKickbacks times', () => {
        const stage = makeStage({ maxKickbacks: 3, onFail: 'implementing' });

        const first = kickback(stage, {});
        expect(first.target).toBe('implementing');
        expect(first.retries.testing).toBe(1);

        const second = kickback(stage, first.retries);
        expect(second.target).toBe('implementing');
        expect(second.retries.testing).toBe(2);
    });

    it('routes to needs-human on the maxKickbacks-th failure, not one beyond it', () => {
        const stage = makeStage({ maxKickbacks: 3, onFail: 'implementing' });

        const third = kickback(stage, { testing: 2 });

        expect(third.retries.testing).toBe(3);
        expect(third.target).toBe('needs-human');
    });

    it('does not route to needs-human before maxKickbacks failures', () => {
        const stage = makeStage({ maxKickbacks: 3, onFail: 'implementing' });

        const second = kickback(stage, { testing: 1 });

        expect(second.retries.testing).toBe(2);
        expect(second.target).toBe('implementing');
    });

    it('keeps counters for other stages independent', () => {
        const stage = makeStage({ name: 'testing', maxKickbacks: 5 });
        const existing = { review: 2, testing: 1 };

        const decision = kickback(stage, existing);

        expect(decision.retries).toEqual({ review: 2, testing: 2 });
    });

    it('never mutates the caller-supplied retries object', () => {
        const stage = makeStage();
        const original = { testing: 1 };
        const originalCopy = { ...original };

        kickback(stage, original);

        expect(original).toEqual(originalCopy);
    });

    it('returns a new retries object rather than the same reference', () => {
        const stage = makeStage();
        const original = { testing: 1 };

        const decision = kickback(stage, original);

        expect(decision.retries).not.toBe(original);
    });

    it('gives up on the first failure when maxKickbacks is 1', () => {
        const stage = makeStage({ maxKickbacks: 1, onFail: 'implementing' });

        const decision = kickback(stage, {});

        expect(decision.retries.testing).toBe(1);
        expect(decision.target).toBe('needs-human');
    });
});
