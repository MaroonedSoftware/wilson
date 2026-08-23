import { describe, expect, it } from 'vitest';
import { StageConfigSchema, assertRoutesResolve } from '#modules/stages/stage.config.js';
import type { VerificationInput, VerificationOutcome } from '#modules/stages/stage.verifier.js';
import { StageVerifierMap, type StageVerifier } from '#modules/stages/stage.verifier.js';

/**
 * The map is the whole seam: `StageDispatcher` resolves a verifier by name and never imports a
 * concrete one. These tests exercise the map directly rather than the dispatcher, because the map
 * is what card 0003's testing verifier plugs into.
 */
describe('StageVerifierMap', () => {
    const fakeVerifier = (outcome: VerificationOutcome): StageVerifier => ({
        verify: async (_input: VerificationInput) => outcome,
    });

    it('resolves a registered verifier by name', async () => {
        const map = new StageVerifierMap();
        const verifier = fakeVerifier({ passed: true, failures: [], changedPaths: ['src/a.ts'] });
        map.set('implementing', verifier);

        const resolved = map.get('implementing');
        expect(resolved).toBe(verifier);
        await expect(resolved?.verify({} as VerificationInput)).resolves.toEqual({ passed: true, failures: [], changedPaths: ['src/a.ts'] });
    });

    it('leaves an unknown verifier name absent, which is the dispatcher’s cue to throw', () => {
        const map = new StageVerifierMap();
        map.set('implementing', fakeVerifier({ passed: true, failures: [], changedPaths: [] }));

        expect(map.get('testing')).toBeUndefined();
    });
});

describe('StageConfigSchema', () => {
    const baseStage = {
        name: 'implementing',
        mode: 'agent' as const,
        model: 'claude-opus',
        instructions: 'do the thing',
        onPass: 'testing',
        onFail: 'needs-human',
    };

    it('parses a stage without a verifier field', () => {
        const parsed = StageConfigSchema.safeParse(baseStage);
        expect(parsed.success).toBe(true);
        expect(parsed.data?.verifier).toBeUndefined();
    });
});

describe('assertRoutesResolve', () => {
    const stage = (name: string, onPass: string, onFail: string) => ({
        name,
        mode: 'agent' as const,
        worktree: 'rw' as const,
        worktreeFrom: 'base' as const,
        extraScope: [],
        provider: 'anthropic' as const,
        model: 'm',
        instructions: '',
        allowedCommands: [],
        maxSteps: 10,
        maxOutputTokens: 1024,
        onPass,
        onFail,
        maxKickbacks: 3,
        baselineCheck: true,
    });
    const config = (...stages: ReturnType<typeof stage>[]) => ({ scopeViolation: 'widen' as const, alwaysAllowed: [], deny: [], stages });

    it('accepts a route to another configured stage', () => {
        expect(() => assertRoutesResolve(config(stage('a', 'b', 'a'), stage('b', 'merged', 'a')))).not.toThrow();
    });

    it('accepts a route to a terminal state', () => {
        expect(() => assertRoutesResolve(config(stage('a', 'merged', 'needs-human')))).not.toThrow();
    });

    it('rejects a route to a stage nobody built, naming it', () => {
        // Card 0011 found this by being stranded: implementing.onFail was `planning`, the transition
        // was written exactly as configured, and the card landed where nothing dispatches.
        expect(() => assertRoutesResolve(config(stage('implementing', 'testing', 'planning')), 'stages.yaml')).toThrow(
            /implementing\.onFail → "planning"/,
        );
    });

    it('lists the valid targets so the fix is obvious', () => {
        expect(() => assertRoutesResolve(config(stage('a', 'nowhere', 'a')))).toThrow(/Valid targets:.*merged/);
    });
});
