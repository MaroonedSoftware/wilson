import { describe, expect, it } from 'vitest';
import { atDepth, scalesWithDiff, withDepth } from '#modules/stages/lane.depth.js';
import { findStage, parseStages, type StageConfig } from '#modules/stages/stage.config.js';

const lanes = (depths: string, mode = 'agent') => `
stages:
  - name: review
    mode: ${mode}
    model: lane-model
    maxSteps: 150
    maxInputTokens: 20000000
    instructions: review it
    onPass: merged
    onFail: review
${depths}
    steps:
      - name: challenge
        on: revise
        instructions: challenge it
`;

const LADDER = `    depths:
      - { minChangedLines: 0, model: small-model, maxSteps: 40, maxInputTokens: 2000000 }
      - { minChangedLines: 50, maxSteps: 80 }
      - { minChangedLines: 500 }`;

const review = (depths = LADDER): StageConfig => findStage(parseStages(lanes(depths), 'test'), 'review');
const lines = (added: number, removed = 0) => ({ added, removed });

describe('withDepth', () => {
    it('takes the highest tier the diff reaches, counting added and removed lines', () => {
        expect(withDepth(review(), lines(49)).depth?.minChangedLines).toBe(0);
        expect(withDepth(review(), lines(25, 25)).depth?.minChangedLines).toBe(50);
        expect(withDepth(review(), lines(499, 1)).depth?.minChangedLines).toBe(500);
    });

    it('sets what the tier names and leaves the rest as the lane has it', () => {
        expect(withDepth(review(), lines(1))).toMatchObject({ model: 'small-model', maxSteps: 40, maxInputTokens: 2_000_000 });
        expect(withDepth(review(), lines(50))).toMatchObject({ model: 'lane-model', maxSteps: 80, maxInputTokens: 20_000_000 });
    });

    it('lets a top tier put the lane back as written', () => {
        expect(withDepth(review(), lines(500))).toMatchObject({ model: 'lane-model', maxSteps: 150, maxInputTokens: 20_000_000 });
    });

    it('returns a copy, since the config it came from is frozen', () => {
        const stage = review();

        const deep = withDepth(stage, lines(1));

        expect(Object.isFrozen(deep)).toBe(false);
        expect(deep).not.toBe(stage);
        expect(stage.model).toBe('lane-model');
    });

    it('runs the lane as written below every tier', () => {
        const stage = review(`    depths:\n      - { minChangedLines: 100, model: big-model }`);

        expect(withDepth(stage, lines(99))).toBe(stage);
    });

    it('runs the lane as written when the diff could not be measured', () => {
        const stage = review();

        expect(withDepth(stage, undefined)).toBe(stage);
    });

    it('does nothing to a lane with no tiers', () => {
        const stage = review('');

        expect(scalesWithDiff(stage)).toBe(false);
        expect(withDepth(stage, lines(10_000))).toBe(stage);
    });

    it('does not reach a step, which runs on its lane', () => {
        const challenge = findStage(parseStages(lanes(LADDER), 'test'), 'review', 'challenge');

        expect(scalesWithDiff(challenge)).toBe(false);
        expect(withDepth(challenge, lines(1))).toBe(challenge);
    });
});

describe('atDepth', () => {
    it('records the tier it applied', () => {
        const depth = { minChangedLines: 7, model: 'other-model' };

        expect(atDepth(review(), depth)).toMatchObject({ model: 'other-model', maxSteps: 150, depth });
    });
});

describe('the depths field', () => {
    const refused = (yaml: string) => expect(() => parseStages(yaml, 'test'));

    it('is off unless a lane names it', () => {
        expect(review('').depths).toBeUndefined();
    });

    it('refuses tiers that do not go up', () => {
        refused(lanes(`    depths:\n      - { minChangedLines: 50 }\n      - { minChangedLines: 50 }`)).toThrow(/depths must go up/);
        refused(lanes(`    depths:\n      - { minChangedLines: 50 }\n      - { minChangedLines: 10 }`)).toThrow(/depths must go up/);
    });

    it('refuses a lane with no model run to scale', () => {
        refused(lanes(LADDER, 'command')).toThrow(/no diff can scale it/);
    });

    it('refuses a misspelt field rather than quietly keeping the lane’s value', () => {
        refused(lanes(`    depths:\n      - { minChangedLines: 0, maxStep: 10 }`)).toThrow(/maxStep/);
    });

    it('refuses budgets a run could not start on, as a step’s are', () => {
        refused(lanes(`    depths:\n      - { minChangedLines: 0, maxSteps: 0 }`)).toThrow();
        refused(lanes(`    depths:\n      - { minChangedLines: 0, maxInputTokens: 10 }`)).toThrow();
        refused(lanes(`    depths:\n      - { minChangedLines: -1 }`)).toThrow();
    });
});
