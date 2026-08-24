import { describe, expect, it } from 'vitest';
import { whyNotDispatchable } from '#modules/jobs/dispatchable.js';
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

describe('whyNotDispatchable', () => {
    it('refuses every terminal state, naming it and saying the card is finished', () => {
        for (const target of ['merged', 'needs-human', 'poisoned', 'dropped']) {
            const result = whyNotDispatchable(target, stages([]));

            expect(result).toBeDefined();
            expect(result?.reason).toContain(target);
            expect(result?.reason).toContain('finished');
        }
    });

    it('refuses parking-lot for a different reason than a terminal state: parked, not finished', () => {
        const result = whyNotDispatchable('parking-lot', stages([]));

        expect(result).toBeDefined();
        expect(result?.reason).toContain('parked');
        expect(result?.reason).not.toContain('finished');
        expect(result?.reason).not.toContain('terminal');
    });

    it('refuses a stage name nothing configures, and lists the configured stage names to fix it', () => {
        const result = whyNotDispatchable('nonexistent', stages([makeStage({ name: 'implementing' }), makeStage({ name: 'testing' })]));

        expect(result).toBeDefined();
        expect(result?.reason).toContain('nonexistent');
        expect(result?.reason).toContain('implementing');
        expect(result?.reason).toContain('testing');
    });

    it('refuses a manual stage, naming the mode and stating the runner will not dispatch it — distinct from the terminal-state wording', () => {
        const result = whyNotDispatchable('review', stages([makeStage({ name: 'review', mode: 'manual' })]));

        expect(result).toBeDefined();
        expect(result?.reason).toContain('review');
        expect(result?.reason).toContain('manual');
        expect(result?.reason).not.toContain('finished');
        expect(result?.reason).not.toContain('terminal');
    });

    it('refuses a command stage, naming the "command" mode', () => {
        const result = whyNotDispatchable('lint', stages([makeStage({ name: 'lint', mode: 'command' })]));

        expect(result).toBeDefined();
        expect(result?.reason).toContain('lint');
        expect(result?.reason).toContain('command');
    });

    it('allows an agent stage through, returning undefined', () => {
        const result = whyNotDispatchable('implementing', stages([makeStage({ name: 'implementing', mode: 'agent' })]));

        expect(result).toBeUndefined();
    });

    it('checks terminal status ahead of stage lookup, so a terminal name with no matching stage still gets the terminal-specific reason', () => {
        const result = whyNotDispatchable('needs-human', stages([makeStage({ name: 'implementing' })]));

        expect(result).toBeDefined();
        expect(result?.reason).toContain('finished');
    });
});
