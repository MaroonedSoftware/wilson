import type { ScopeGuard } from '#modules/agent/scope.guard.js';
import type { Worktree } from '#modules/worktree/worktree.manager.js';
import type { StageConfig } from './stage.config.js';

export interface VerificationInput {
    worktree: Worktree;
    scope: ScopeGuard;
    stage: StageConfig;
    /** The card being verified. Only the testing verifier's baseline check uses it. */
    cardId: string;
}

export interface VerificationOutcome {
    passed: boolean;
    failures: string[];
    changedPaths: string[];
}

export interface StageVerifier {
    verify(input: VerificationInput): Promise<VerificationOutcome>;
}

/**
 * The DI token for the stage-name -> verifier map. A class extending Map is registered by
 * identity, the same way this repo's other registry maps are:
 * `registry.register(StageVerifierMap).useInstance(map)`.
 */
export class StageVerifierMap extends Map<string, StageVerifier> {}
