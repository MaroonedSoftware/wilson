import { describe, expect, it } from 'vitest';
import { whyNotDispatchable } from '#modules/jobs/dispatchable.js';
import type { ProjectStages, StageConfig } from '#modules/stages/stage.config.js';
import type { Card, CardFrontmatter } from '#modules/board/card.js';

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

const card = (stage: string): Card => ({
    frontmatter: {
        id: '0001',
        title: 'a card',
        stage,
        dependsOn: [],
        retries: {},
    } as CardFrontmatter,
    sections: {},
    body: '',
});

describe('whyNotDispatchable', () => {
    it('refuses every terminal state, naming it and saying the card is finished', () => {
        for (const target of ['merged', 'poisoned', 'dropped']) {
            const result = whyNotDispatchable(card(target), stages([]));

            expect(result).toBeDefined();
            expect(result?.reason).toContain(target);
            expect(result?.reason).toContain('finished');
        }
    });

    it('refuses parking-lot for a different reason than a terminal state: parked, not finished', () => {
        const result = whyNotDispatchable(card('parking-lot'), stages([]));

        expect(result).toBeDefined();
        expect(result?.reason).toContain('parked');
        expect(result?.reason).not.toContain('finished');
        expect(result?.reason).not.toContain('terminal');
    });

    it('refuses a stage name nothing configures, and lists the configured stage names to fix it', () => {
        const result = whyNotDispatchable(card('nonexistent'), stages([makeStage({ name: 'implementing' }), makeStage({ name: 'testing' })]));

        expect(result).toBeDefined();
        expect(result?.reason).toContain('nonexistent');
        expect(result?.reason).toContain('implementing');
        expect(result?.reason).toContain('testing');
    });

    it('refuses a manual stage, naming the mode and stating the runner will not dispatch it — distinct from the terminal-state wording', () => {
        const result = whyNotDispatchable(card('review'), stages([makeStage({ name: 'review', mode: 'manual' })]));

        expect(result).toBeDefined();
        expect(result?.reason).toContain('review');
        expect(result?.reason).toContain('manual');
        expect(result?.reason).not.toContain('finished');
        expect(result?.reason).not.toContain('terminal');
    });

    it('refuses a command stage, naming the "command" mode', () => {
        const result = whyNotDispatchable(card('lint'), stages([makeStage({ name: 'lint', mode: 'command' })]));

        expect(result).toBeDefined();
        expect(result?.reason).toContain('lint');
        expect(result?.reason).toContain('command');
    });

    it('allows an agent stage through, returning undefined', () => {
        const result = whyNotDispatchable(card('implementing'), stages([makeStage({ name: 'implementing', mode: 'agent' })]));

        expect(result).toBeUndefined();
    });

    it('checks terminal status ahead of stage lookup, so a terminal name with no matching stage still gets the terminal-specific reason', () => {
        const result = whyNotDispatchable(card('poisoned'), stages([makeStage({ name: 'implementing' })]));

        expect(result).toBeDefined();
        expect(result?.reason).toContain('finished');
    });

    // Card 0054: the guards learn about the flag. A card can be flagged for a human while it sits in
    // any stage at all, including a perfectly normal agent stage, so the refusal has to name the flag
    // rather than describe the stage as if that were the problem.
    describe('needsHuman', () => {
        const flagged = (stage: string, reason?: string): Card => ({
            frontmatter: {
                id: '0001',
                title: 'a card',
                stage,
                dependsOn: [],
                retries: {},
                needsHuman: true,
                needsHumanReason: reason,
            } as CardFrontmatter,
            sections: {},
            body: '',
        });

        it('refuses a card flagged for a human sitting in an otherwise-dispatchable agent stage', () => {
            const result = whyNotDispatchable(flagged('implementing'), stages([makeStage({ name: 'implementing', mode: 'agent' })]));

            expect(result).toBeDefined();
            expect(result?.reason).toContain('human');
        });

        it('includes the operator-given reason in the refusal', () => {
            const result = whyNotDispatchable(
                flagged('implementing', 'balance is wrong, needs a look'),
                stages([makeStage({ name: 'implementing', mode: 'agent' })]),
            );

            expect(result?.reason).toContain('balance is wrong, needs a look');
        });

        it('checks the flag before terminal status, so a flagged card in a terminal stage still names the flag, not the stage', () => {
            const result = whyNotDispatchable(flagged('merged'), stages([]));

            expect(result).toBeDefined();
            expect(result?.reason).toContain('human');
            expect(result?.reason).not.toContain('finished');
        });

        it('checks the flag before parking-lot', () => {
            const result = whyNotDispatchable(flagged('parking-lot'), stages([]));

            expect(result?.reason).toContain('human');
            expect(result?.reason).not.toContain('parked');
        });

        it('does not refuse an unflagged card in the same agent stage', () => {
            const result = whyNotDispatchable(card('implementing'), stages([makeStage({ name: 'implementing', mode: 'agent' })]));

            expect(result).toBeUndefined();
        });
    });
});
